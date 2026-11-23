// Local (Ollama) module: used by the project-workspace module for the Local LLM tab.
export { default as OllamaPanel } from '@/modules/ollama/OllamaPanel';
export { useOllamaStatus } from '@/modules/ollama/hooks/useOllamaStatus';
export type { OllamaHealth, OllamaStatus } from '@/modules/ollama/hooks/useOllamaStatus';
export { readEventStream } from '@/modules/ollama/utils/ollamaChat';
