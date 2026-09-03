export function shouldRemoveModerator(status: { error: boolean; isModerator: boolean }): boolean {
    return !status.error && status.isModerator;
}
