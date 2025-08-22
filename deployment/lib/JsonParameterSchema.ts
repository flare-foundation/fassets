/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { readFileSync } from "fs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Ajv = require('ajv');
const ajv = new Ajv();

export class JsonParameterSchema<T> {
    private ajvSchema: any;

    constructor(ajvSchemaJson: any) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.ajvSchema = ajv.compile(ajvSchemaJson);
    }

    load(filename: string): T {
        const parameters = JSON.parse(readFileSync(filename).toString());
        return this.validate(parameters);
    }

    validate(parameters: unknown): T {
        if (this.ajvSchema(parameters)) {
            return parameters as T;
        }
        throw new Error(`Invalid format of parameter file`);
    }
}
