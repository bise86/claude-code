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
   * 这个员工真正的上下文窗口(token 数),自动压缩按它触发。
   *
   * 必须挂在**这个**对象上而不是 agentDef 上:`query.ts` 唯一能看见员工身份的东西就是
   * `toolUseContext.options.roleClientConfig`,而压缩发生在查询循环里(`autoCompactIfNeeded`)。
   * 缺省时按协议分档,见 `roleContextWindow.ts` 的文件头。
   */
  contextWindow?: number
  /**
   * 这个配置是谁的 —— **只用于报错**。
   *
   * 一次 `/et` 跑起来可以有十几个员工同时在说话,而上游失败的那句话如果不点名,用户
   * 拿到的是「某个 openai-responses 员工挂了」,他手上有三个。可选是因为测试和历史配置
   * 里造这个对象的地方不止一处,而缺一个名字不该让报错本身炸掉。
   */
  roleName?: string
}
