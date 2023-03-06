//Used for sync HTTP communication between services
import {WinstonLogger} from "mein-winston-logger";
import {sidecarLogger} from "./logger";
import axios from "axios";
import {NextFunction, Request, Response} from "express";
import * as EtcdRegistry from "./service-registry.js";


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
        const commit_failed = commited_.find(success_ => !success_.success)
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
                    phase: phase,
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
        const logger = this.transport.logger
        return async function func(req: Request, res: Response) {
            const phase = req.body.phase
            //todo: NAME
            logger.info('Running phase', phase)
            switch (phase) {
                case CommitPhases.prepare:
                    const prepared_ = await actions.prepare(req)
                    logger.info(phase + ' result , success : ' + !!prepared_.success)
                    if (!prepared_.success) {
                        res.status(200).json({
                            success: false
                        })
                        break
                    }
                    res.status(200).json({success: true})
                    break
                case CommitPhases.abort:
                    const aborted_ = await actions.abort(req)
                    logger.info(phase + ' result , success : ' + !!aborted_.success)
                    if (!aborted_.success) {
                        res.status(200).json({
                            success: false
                        })
                        break
                    }
                    res.status(200).json({success: true})
                    break
                case CommitPhases.commit:
                    const commited_ = await actions.abort(req)
                    logger.info(phase + ' result , success : ' + !!commited_.success)
                    if (!commited_.success) {
                        res.status(200).json({
                            success: false
                        })
                        break
                    }
                    res.status(200).json({success: true})
                    break
                default:
                    res.status(200).json({
                        success: false
                    })
                    break
            }
        }
    }


}