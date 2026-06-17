// AI Harness - New unified entry point with tool calling
export { chat, MODELS, TOKEN_LIMITS } from './ai.js';
export type { 
    IRouterResponse, 
    IStreamerData, 
    IChatHistoryMessage, 
    IChatMessageTags,
    IAIDecision,
    IToolContext,
    ISearchResult,
    ICodePlanResult, 
    ICodeGenerationResult, 
    ISandboxExecutionResult,
    SearchResult,
    SearchToolResult
} from './ai.js';

// Re-export from messages.ai.ts for $(ai) commands
export { AiResponse } from './messages.ai.js';

// Execute AI commands (for $(ai) syntax - no tool calling needed)
export { executeAiCommand } from './command.ai.js';

// Embeddings
export { generateEmbedding, generateEmbeddings, detectLanguage, type IOpenRouterEmbeddingRequest, type IOpenRouterEmbeddingResponse, type IOpenRouterEmbeddingError, type IEmbeddingResult, type IBatchEmbeddingResult } from './embeddings.ai.js';
