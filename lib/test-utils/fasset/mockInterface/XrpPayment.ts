export namespace XrpPayment {
    export const NAME = "XrpPayment";
    export const TYPE = "0x5872705061796d656e7400000000000000000000000000000000000000000000";

    /**
     * Toplevel request
     */
    export interface Request {
        /**
         * ID of the attestation type.
         */
        attestationType: string;

        /**
         * ID of the data source.
         */
        sourceId: string;

        /**
         * `MessageIntegrityCode` that is derived from the expected response.
         */
        messageIntegrityCode: string;

        /**
         * Data defining the request. Type (struct) and interpretation is determined by the `attestationType`.
         */
        requestBody: RequestBody;
    }

    /**
     * Toplevel response
     */
    export interface Response {
        /**
         * Extracted from the request.
         */
        attestationType: string;

        /**
         * Extracted from the request.
         */
        sourceId: string;

        /**
         * The ID of the State Connector round in which the request was considered.
         */
        votingRound: string;

        /**
         * The lowest timestamp used to generate the response.
         */
        lowestUsedTimestamp: string;

        /**
         * Extracted from the request.
         */
        requestBody: RequestBody;

        /**
         * Data defining the response. The verification rules for the construction of the response body and the type are defined per specific `attestationType`.
         */
        responseBody: ResponseBody;
    }

    /**
     * Toplevel proof
     */
    export interface Proof {
        /**
         * Merkle proof corresponding to the attestation response.
         */
        merkleProof: string[];

        /**
         * Attestation response.
         */
        data: Response;
    }

    /**
     * Request body for XrpPayment attestation type
     */
    export interface RequestBody {
        /**
         * ID of the payment transaction.
         */
        transactionId: string;

        /**
         * Address that is allowed to execute the method that requires this attestation.
         *  If zero, any address can execute.
         */
        allowedExecutor: string;
    }

    /**
     * Response body for XrpPayment attestation type
     */
    export interface ResponseBody {
        /**
         * Number of the block in which the transaction is included.
         */
        blockNumber: string;

        /**
         * The timestamp of the block in which the transaction is included.
         */
        blockTimestamp: string;

        /**
         * Standard address hash of the source address.
         */
        sourceAddressHash: string;

        /**
         * Standard address hash of the receiving address.
         */
        receivingAddressHash: string;

        /**
         * Standard address hash of the intended receiving address.
         */
        intendedReceivingAddressHash: string;

        /**
         * Amount in minimal units spent by the source address.
         */
        spentAmount: string;

        /**
         * Amount in minimal units to be spent by the source address.
         */
        intendedSpentAmount: string;

        /**
         * Amount in minimal units received by the receiving address.
         */
        receivedAmount: string;

        /**
         * Amount in minimal units intended to be received by the receiving address.
         */
        intendedReceivedAmount: string;

        /**
         * Indicator whether the transaction has memo data.
         */
        hasMemoData: boolean;

        /**
         * The first memo data field of the transaction.
         */
        firstMemoData: string;

        /**
         * Indicator whether the transaction has an XRP tag.
         */
        hasTag: boolean;

        /**
         * The tag of the transaction. Zero if `hasTag` is false.
         */
        tag: string;

        /**
         * Succes status of the transaction: 0 - success, 1 - failed by sender's fault, 2 - failed by receiver's fault.
         */
        status: string;
    }

    export type RequestNoMic = Omit<Request, "messageIntegrityCode">;
}
