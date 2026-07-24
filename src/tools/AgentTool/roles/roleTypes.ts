export type RoleClientConfig = {
  apiProtocol: 'anthropic' | 'openai'
  apiUrl: string
  apiToken: string
  backendModel: string
  thinkingDepth?: string
}

export type RoleConfig = {
  name: string
  whenToUse: string
  execMode: 'api' | 'cli'
  tools?: string[]
  prompt?: string
  api?: RoleClientConfig
  command?: string
  args?: string[]
  interactive?: boolean
  roleCwd?: string
}
