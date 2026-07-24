export type RoleClientConfig = {
  apiProtocol: 'anthropic' | 'openai'
  apiUrl: string
  apiToken: string
  backendModel: string
  thinkingDepth?: string
}
