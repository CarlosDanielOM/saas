import { setAvailability } from '../utils/availability/service.js';

interface EnableCommandResponse {
    error: boolean;
    message: string;
    status?: number;
    type?: string;
}

export async function enableCommandCommand(channelID: string, argument: string): Promise<EnableCommandResponse> {
    try {
        await setAvailability('command', channelID, argument.trim(), true);

        return {
            error: false,
            message: `Command ${argument} is now enabled`,
            status: 200,
            type: 'command_enabled'
        };
    } catch (error) {
        console.error(`Error in enableCommandCommand:`, {
            channelID,
            argument,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return {
            error: true,
            message: error instanceof Error ? error.message : 'Internal server error',
            status: error instanceof Error && /not found/i.test(error.message) ? 404 : 500,
            type: 'error'
        };
    }
}
