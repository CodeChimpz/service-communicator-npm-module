import axios from "axios";
import {LoggerService, WinstonLoggerService} from "logger";

export interface GatewayConfigOptions {
    url: string
    //how the gateway will refer to the service when registering endpoints
    refer: string
    //api key given by the gateway to the service
    api_key: string
    //endpoints
    endpoints: ApiObjectT
    //for testing on localhost when Origin header is not sent
    origin?: string
}

// export type HttpMethodT = 'get' | 'post' | 'delete' | 'put'
export type ApiObjectT = {
    [key: string]: string
}


export class GatewayCommunicator {
    logger: LoggerService
    config: GatewayConfigOptions

    constructor(config: GatewayConfigOptions) {
        this.logger = new WinstonLoggerService({
            path: "./logs",
            console: true,
            maxsize: 59999
        })
        this.config = config
    }

    //send all the endpoint routes passed on init to the gateway endpoint registration checkpoint
    async sync() {
        try {
            const response = await axios.post(this.config.url, {
                auth: this.config.api_key,
                service: this.config.refer,
                endpoints: this.config.endpoints,
                origin: this.config.origin,
            }, {})
            this.logger.http.info(response.data, {status: response.status})
        } catch (e: any) {
            this.logger.http.error(e)
        }
    }

}

