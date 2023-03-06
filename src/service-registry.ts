//used for service discovery and endpoint proxying
import {Etcd3, IOptions} from "etcd3";
import {LoggerService, WinstonLogger, WinstonLoggerService} from "mein-winston-logger";
import {registryLogger} from "./logger.js";

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
    logger: WinstonLogger
    data: IRegistryData | undefined

    constructor(config: IConfigOptions, data?: IRegistryData) {
        this.logger = registryLogger
        // this.config = config
        this.etcd = new Etcd3({
            hosts: config.hosts,
            auth: config?.auth,
            credentials: config?.credentials,
        })
        if (data) {
            this.data = data
        }
        this.namespace = config?.namespace || 'services'
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


