import axios from "axios";
import amqplib from 'amqplib'
import {LoggerService, WinstonLogger, WinstonLoggerService} from "mein-winston-logger";
import {Etcd3, IOptions} from "etcd3";
import {NextFunction, Request, Response} from "express";
import {mqLogger, sidecarLogger} from "./logger.js";

//used for service discovery and endpoint proxying
export namespace EtcdRegistry {
    //data that the service will send to the etcd registry
    export interface IRegistryData {
        //the url of the service (you gotta know it somehow)
        serviceUrl: string
        //how the gateway will refer to the service when registering endpoints
        refer: string
        //endpoints
        endpoints: TApiObjectT
    }

//Specific dor the Registry instance options
    export interface IConfigOptions extends IOptions {
        namespace?: string
    }

//Maps endpoint tokens to urls, the protocol for tokens is {path}.{to}.{resource}.{method = 'get'|'post'|'delete'}
    export type TApiObjectT = {
        //north south
        public?: {
            [token: string]: string
        }
    }

//Service Registry based on Etcd , a service uploads it's endpoint's and it's url into a /services/ namespace
//on etcd server,that then another service may use.
//Designed for north-south communication between API Gateway and microservices
//No inherent security mechanism.
    export class ServiceRegistry {
        etcd: Etcd3
        namespace: string
        // config: GatewayConfigOptions
        //util dependencies
        logger: LoggerService
        data: IRegistryData | undefined

        constructor(config: IConfigOptions, data?: IRegistryData, namespace?: string) {
            this.logger = new WinstonLoggerService({
                path: "./logs",
                console: true,
                maxsize: 59999
            })
            // this.config = config
            this.etcd = new Etcd3({
                hosts: config.hosts,
                auth: config?.auth,
                credentials: config?.credentials,
            })
            if (data) {
                this.data = data
            }
            this.namespace = namespace || 'services'
        }

        //notify the registry of server spin up, upload it's data for other service discovery
        async init() {
            if (!this.data) {
                throw new Error('Trying to init but no data specified')
            }
            const data = this.data
            const nmspc = this.etcd.namespace(this.namespace).namespace(data.refer)
            await nmspc.put('name').value(data.serviceUrl).exec()
            await nmspc.put('endpoints').value(JSON.stringify(data.endpoints)).exec()
        }

        //get from registry the url for service endpoint for token {service}.{path...}.{method = 'get'|'post'|'delete'}, public or private
        async route(endpoint_token: string) {
            const parsed_token = endpoint_token.split('.')
            //parse token
            const service = parsed_token[0]
            const endpoint = parsed_token.slice(1).join('.')
            //get data from etcd
            const nmspc = this.etcd.namespace(this.namespace).namespace(service)
            const name = await nmspc.get('name')
            const endpoints = await nmspc.get('endpoints').json()
            if (!(endpoints && name)) throw new Error('No endpoint registered for this token')
            const path = JSON.parse(JSON.stringify(endpoints))[endpoint]
            return name + path
        }

        //returns the services location for inter-service http communication (functions as a DNS)
        async service(name: string) {
            const nmspc = this.etcd.namespace(this.namespace).namespace(name)
            return nmspc.get('name')
        }


    }
}

//Used for sync HTTP communication between services
export namespace HttpCommunication {
    export interface IRequestConfig {
        //name of service
        name: string,
        //endpoint on service
        endpoint: string,
        method: 'get' | 'post' | 'put' | 'delete',
        params: {
            API_KEY: string
        }
    }

//uses a Registry instance to send inter service http requests based on the registry DNS functions
    export class Sidecar {
        registry: EtcdRegistry.ServiceRegistry
        key: string
        logger: WinstonLogger

        //
        constructor(registry: EtcdRegistry.ServiceRegistry, api_key: string) {
            this.registry = registry
            this.key = api_key
            this.logger = sidecarLogger
        }

        //sends a sync http request to a service
        async sendRequest(config: IRequestConfig, payload: any): Promise<{ data: any, error?: any }> {
            const {name, method, endpoint, params} = config
            const host = await this.registry.service(name)
            if (!host) {
                throw new Error('Host not found for such name on the registry')
            }
            const url = host + endpoint
            const result = await axios.request({
                method: method,
                url: url,
                headers: {
                    Authorization: params.API_KEY
                },
                data: payload
            })
            return {data: result.data}
        }

        //An express middleware that provides authentication by the http header Api_key
        async registerEndpoint(req: Request, res: Response, next: NextFunction): Promise<void> {
            const api_key = req.headers.authorization
            //todo: should I encrypt the api_key on the side of the service ? I mean it's only stored in memory and in secrets so like idk
            if (api_key !== this.key) {
                res.status(401).json({message: 'Service not authorized'})
                return
            } else {
                next()
                return
            }
        }
    }

//used for 2PC, uses Sidecar to send requests
    export type CommitSources = { endpoint: { name: string, endpoint: string, auth: string }, data: any }[]

    enum CommitPhases {
        prepare = 'prepare',
        prepared = 'prepared',
        abort = 'abort',
        aborted = 'aborted',
        commit = 'commit',
        commited = 'commited'
    }


    type CommitConsumer = (req: Request, ...args: any[]) => Promise<CommitCbData> | CommitCbData
    type CommitCbData = { success: boolean, ctx?: any }

    export class TransactionSync {
        transport: Sidecar

        //
        constructor(sidecar: Sidecar) {
            this.transport = sidecar
        }

        //todo: Aggregate data from services
        //orchestrates commit phases, doesn't return data from services, only checks if commit phase ran successfully
        async twoPCommit(participants: CommitSources): Promise<boolean> {
            //prepare
            const prepared_: CommitCbData[] = await this.propagatePhase(CommitPhases.prepare, participants)
            const failed = prepared_.find(resolved_ => !resolved_.success)
            if (failed) {
                const aborted_ = await this.propagatePhase(CommitPhases.abort, participants, failed.ctx)
                return false
            }
            const commited_ = await this.propagatePhase(CommitPhases.commit, participants)
            const commit_failed = prepared_.find(success_ => !success_.success)
            if (commit_failed) {
                const aborted_ = await this.propagatePhase(CommitPhases.abort, participants, commit_failed.ctx)
                return false
            }
            return true
        }

        // util, handles actual sending of requests
        async propagatePhase(phase: CommitPhases, participants: CommitSources, additional?: any): Promise<CommitCbData[]> {
            return Promise.all(participants.map(async (participant) => {
                try {
                    const config: IRequestConfig = {
                        name: participant.endpoint.name,
                        endpoint: participant.endpoint.endpoint,
                        method: 'post',
                        params: {
                            API_KEY: participant.endpoint.auth
                        }
                    }
                    const {data, error} = await this.transport.sendRequest(config, {
                        phase: CommitPhases.prepare,
                        data: {...participant.data, ctx: additional}
                    })
                    if (data.success !== true) {
                        return {success: false, ctx: error};
                    }
                    return {success: true, ctx: data};
                } catch (e: any) {
                    this.transport.logger.error(e)
                    return {success: false, ctx: 'Server error'}
                }
            }))
        }

        //Single endpoint Controller Factory for handling different commit phases, depends on Express
        //Runs functions and sends Request with results
        commitConsumerFactory(actions: Record<CommitPhases.prepare | CommitPhases.commit | CommitPhases.abort, CommitConsumer>) {
            return async function func(req: Request, res: Response) {
                const phase = req.body.phase
                switch (phase) {
                    case CommitPhases.prepare:
                        const prepared_ = await actions.prepare(req)
                        if (!prepared_) {
                            res.status(400).json({
                                success: false
                            })
                            break
                        }
                        res.status(200).json({success: true})
                        break
                    case CommitPhases.abort:
                        const aborted_ = await actions.abort(req)
                        if (!aborted_) {
                            res.status(400).json({
                                success: false
                            })
                            break
                        }
                        res.status(200).json({success: true})
                        break
                    case CommitPhases.commit:
                        const commited_ = await actions.abort(req)
                        if (!commited_) {
                            res.status(400).json({
                                success: false
                            })
                            break
                        }
                        res.status(200).json({success: true})
                        break
                    default:
                        res.status(400).json({
                            success: false
                        })
                        break
                }
            }
        }
    }

}

//Used for asynchronous Messaging and Saga choreography
export namespace AmqpBroker {
    export type Connection = amqplib.Connection

    export async function connect(connect: string, queueName: string) {
        const connection = await amqplib.connect(connect)
        return new SagaChoreographer(connection, queueName)
    }

    export type TStepHandlerFunc<T> = (content: any, connection: SagaChoreographer) => Promise<T>

    export class SagaChoreographer {
        connection: amqplib.Connection
        queue: string
        logger: LoggerService | undefined
        //
        forward = '_forward'
        back = '_back'

        constructor(connection: amqplib.Connection, queue: string) {
            this.connection = connection
            this.queue = queue
        }

        async registerStep(event: string, stepForward: TStepHandlerFunc<any>, stepBack: TStepHandlerFunc<any>) {
            const ch = await this.connection.createChannel()
            await ch.assertQueue(this.queue)
            mqLogger.info('Asserted ', this.queue)
            await ch.consume(this.queue, async (msg) => {
                const content = msg?.content
                if (!content) {
                    return
                }
                const parsed = JSON.parse(content.toString())
                try {
                    switch (parsed.event) {
                        case event + this.forward:
                            await stepForward(parsed.payload, this)
                            break
                        case event + this.back:
                            await stepBack(parsed.payload, this)
                            break
                        default:
                            break
                    }
                    await ch.ack(msg)
                } catch (e: any) {
                    mqLogger.error(e)
                }
            })
        }

        async invokeStep(queue: string, event: string, direction: 'back' | 'forward', payload: any) {
            const ch = await this.connection.createChannel()
            await ch.assertQueue(this.queue)
            mqLogger.info('Asserted ', this.queue)
            const step = direction === 'forward' ? this.forward : this.back
            const send_ = {
                event: event + step,
                payload: payload
            }
            console.log(send_)
            mqLogger.info('Sending', {queue, send_})
            ch.sendToQueue(queue, Buffer.from(JSON.stringify(send_)))
        }


    }
}