export interface Editor {
    user_id: string;
    user_login: string;
    user_name: string;
}

export function normalizeEditors(editors: Editor[]): Editor[] {
    return editors.map((editor) => ({
        user_id: editor.user_id,
        user_login: editor.user_name.toLowerCase(),
        user_name: editor.user_name
    }));
}
