export type RoleClientConfig = {
  /**
   * 员工用哪种协议说话。
   *
   * 运行期的真相在 `services/api/openaiCompat/protocols.ts` 的注册表里(zod enum 也从那儿
   * 派生);这里写成字面量联合是为了避开反向依赖 —— 那个模块 import 本文件。
   */
  apiProtocol: 'anthropic' | 'openai' | 'openai-responses'
  apiUrl: string
  apiToken: string
  backendModel: string
  thinkingDepth?: string
}
