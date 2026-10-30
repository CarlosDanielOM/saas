import { startTelemetry, instrumentFetch, beginSpan } from '../observability/telemetry.js';
import mongoose, { Mongoose } from "mongoose";

type MongoDBConnection = Mongoose;

let connectionPromise: Promise<MongoDBConnection> | null = null;

export const getMongoDBConnection = async (caller: string = 'unknown') => {
    if (connectionPromise) return connectionPromise;

    const initConnection = async () => {
        mongoose.connection.on('error', (error) => {
            console.error(`Error connecting to MongoDB from ${caller}`, error);
        });

        mongoose.connection.on('connected', () => {
            console.log(`Connected to MongoDB from ${caller}`);
        });

        mongoose.connection.on('disconnected', () => {
            console.log(`MongoDB has been successfuly disconected from ${caller}`);
        });

        try {
            if (!process.env.MONGO_URI) {
                throw new Error('MONGO_URI is not set');
            }
            startTelemetry();
            instrumentFetch();
            const connection = await mongoose.connect(process.env.MONGO_URI!, { monitorCommands: true });
            const pending = new Map<number, ReturnType<typeof beginSpan>>();
            const mongo = mongoose.connection.getClient();
            mongo.on('commandStarted', event => {
                if (pending.size < 1000 && !['hello', 'isMaster', 'saslStart', 'saslContinue', 'authenticate', 'endSessions'].includes(event.commandName)) pending.set(event.requestId, beginSpan('database', `mongo.${event.commandName}`));
            });
            mongo.on('commandSucceeded', event => { pending.get(event.requestId)?.end(); pending.delete(event.requestId); });
            mongo.on('commandFailed', event => { pending.get(event.requestId)?.end('error'); pending.delete(event.requestId); });
            return connection;
        } catch (error) {
            console.error(`Error connecting to MongoDB from ${caller}`, error);
            connectionPromise = null;
            throw error;
        }
    }

    connectionPromise = initConnection();
    return connectionPromise;
}