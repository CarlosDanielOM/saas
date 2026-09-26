import { setAvailability } from '../utils/availability/service.js';

interface DisableCommandResponse {
    error: boolean;
    message: string;
    status?: number;
    type?: string;
}

export async function disableCommandCommand(channelID: string, argument: string): Promise<DisableCommandResponse> {
    try {
        await setAvailability('command', channelID, argument.trim(), false);

        return {
            error: false,
            message: `Command ${argument} is now disabled`,
            status: 200,
            type: 'command_disabled'
        };
    } catch (error) {
        console.error(`Error in disableCommandCommand:`, {
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
