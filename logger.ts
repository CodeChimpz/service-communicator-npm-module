import {defaultStringFormat, formats, WinstonLogger} from "mein-winston-logger";

export const mqLogger = new WinstonLogger({
    path: './logs',
    console: true,
    maxsize:
        4194304,
    label: 'MQ-BROKER',
    format: {color: formats.format.colorize({all: true, colors: {info: 'green', error: 'green'}})}
})