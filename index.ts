import axios from "axios";
import {Logger, WinstonLogger} from "logger";

interface GatewayConfigOptions {
    url: string
    //how the gateway will refer to the service when registering endpoints
    refer: string
    //api key given by the gateway to the service
    api_key: string
    endpoints: Array<string>
}

export class GatewayCommunicator {
    logger: Logger
    config: GatewayConfigOptions

    constructor(config: GatewayConfigOptions) {
        this.logger = new WinstonLogger({
            path: "./logs",
            console: true
        })
        this.config = config
    }

    //send all the endpoint routes passed on init to the gateway endpoint registration checkpoint
    async sync() {
        const response = await axios.post(this.config.url + '/endpoints', {
            auth: this.config.api_key,
            service: this.config.refer,
            endpoints: this.config.endpoints
        })
        //
        if (response.status > 300) {
            throw new Error('Failed to sync with the server: ' + response.data.message)
        }
    }

    //send data to gateway ( e.g. notify that service is down )
    async send(data: any) {
        const response = await axios.post(this.config.url + '/data', {
            auth: this.config.api_key,
            data: data
        })
        return response.data
    }
}

