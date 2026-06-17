import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { resourceFromAttributes } from "@opentelemetry/resources";

let sdk = null;

export default function startSDKLogger(runtime: string) {
    console.log(`Creating opentelemetry by ${runtime}`);
    sdk = new NodeSDK({
        resource: resourceFromAttributes({
            'service.name': "DomDimaBot"
        }),
        logRecordProcessor: new BatchLogRecordProcessor(
            new OTLPLogExporter({
                url: "https://us.i.posthog.com/i/v1/logs",
                headers: {
                    'Authorization': "Bearer phc_ApcLd2XbNHavPCcyD9fFDVHxs7cCBPozWmSBFTqugfP"
                }
            })
        )
    });

    return sdk;
}