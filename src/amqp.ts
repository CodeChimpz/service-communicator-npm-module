//Used for asynchronous Messaging and Saga choreography
import amqplib from "amqplib";
import {LoggerService} from "mein-winston-logger";
import {mqLogger} from "./logger.js";


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
