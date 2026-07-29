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
  /**
   * 这个配置是谁的 —— **只用于报错**。
   *
   * 一次 `/et` 跑起来可以有十几个员工同时在说话,而上游失败的那句话如果不点名,用户
   * 拿到的是「某个 openai-responses 员工挂了」,他手上有三个。可选是因为测试和历史配置
   * 里造这个对象的地方不止一处,而缺一个名字不该让报错本身炸掉。
   */
  roleName?: string
}
