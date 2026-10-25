import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// The media-library upload route is a heavy module (mongoose schemas, S3, Twitch
// lookups), so this test isolates the multer configuration from the real source
// file with the TypeScript AST instead of re-implementing the accepted list.
const source = readFileSync(new URL('./trigger.route.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('trigger.route.ts', source, ts.ScriptTarget.Latest, true);

function collectNodes(node: ts.Node, predicate: (node: ts.Node) => boolean, found: ts.Node[] = []): ts.Node[] {
    if (predicate(node)) {
        found.push(node);
    }

    ts.forEachChild(node, child => {
        collectNodes(child, predicate, found);
    });

    return found;
}

const acceptableMimeTypesDeclaration = parsed.statements.find(
    (node): node is ts.VariableStatement =>
        ts.isVariableStatement(node)
        && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'acceptableMimeTypes')
)!;

const uploadDeclaration = collectNodes(parsed, node =>
    ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'upload')
)[0] as ts.VariableStatement;

assert.ok(acceptableMimeTypesDeclaration, 'acceptableMimeTypes declaration not found in trigger.route.ts');
assert.ok(uploadDeclaration, 'multer upload declaration not found in trigger.route.ts');

const holder: {
    options?: { fileFilter?: Function; limits?: { fileSize?: number } };
    field?: string;
} = {};

const sandbox = {};

const script = [
    "const planTier = 'pro';",
    "const getPlanUploadLimitBytes = (tier) => (tier === 'pro' ? 100 : 5) * 1024 * 1024;",
    acceptableMimeTypesDeclaration.getText(parsed),
    uploadDeclaration.getText(parsed)
].join('\n');

runInNewContext(
    ts.transpileModule(script, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText,
    Object.assign(sandbox, {
        multer: Object.assign(
            (options: any) => {
                holder.options = options;
                return {
                    single: (field: string) => {
                        holder.field = field;
                        return { field };
                    }
                };
            },
            { diskStorage: (config: unknown) => config }
        )
    })
);

function accepts(mimetype: string): boolean {
    const fileFilter = holder.options?.fileFilter;
    assert.ok(fileFilter, 'multer fileFilter was not configured');

    let accepted: boolean | undefined;
    fileFilter({}, { mimetype }, (_error: unknown, ok: boolean) => {
        accepted = ok;
    });

    return accepted === true;
}

test('standard MP3 MIME type audio/mpeg is accepted by the media library upload filter', () => {
    assert.equal(accepts('audio/mpeg'), true);
});

test('the previously accepted audio MIME types are still accepted', () => {
    for (const mimetype of ['audio/mp3', 'audio/flac', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/wma', 'audio/m4a']) {
        assert.equal(accepts(mimetype), true, `${mimetype} should be accepted`);
    }
});

test('the previously accepted image and video MIME types are still accepted', () => {
    for (const mimetype of ['video/mp4', 'video/mov', 'video/avi', 'video/flv', 'video/wmv', 'video/webm', 'video/mkv',
        'image/gif', 'image/jpg', 'image/jpeg', 'image/png', 'image/bmp', 'image/tiff', 'image/svg', 'image/webp']) {
        assert.equal(accepts(mimetype), true, `${mimetype} should be accepted`);
    }
});

test('unsupported file types are still rejected', () => {
    for (const mimetype of ['application/pdf', 'text/plain', 'application/zip', 'application/octet-stream',
        'application/x-msdownload', 'video/quicktime', 'image/svg+xml', 'font/woff2']) {
        assert.equal(accepts(mimetype), false, `${mimetype} should be rejected`);
    }
});
