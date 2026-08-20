export type RoleClientConfig = {
  /**
   * 员工用哪种协议说话。
   *
   * 运行期的真相在 `services/api/openaiCompat/protocols.ts` 的注册表里(zod enum 也从那儿
   * 派生);这里写成字面量联合是为了避开反向依赖 —— 那个模块 import 本文件。
   */
  apiProtocol: 'anthropic' | 'openai' | 'openai-responses'
  /**
   * 这一席用哪条**传输**把请求发出去。默认 `raw`。
   *
   * - `raw`:我们自己的 fetch + SSE 解析(默认,也是唯一在跑机上验过的那条);
   * - `sdk`:官方 `openai` 客户端发请求,产出的帧喂给**同一个**翻译器。
   *
   * 只对翻译型协议(openai / openai-responses)有意义 —— `anthropic` 档是原样转发,
   * 没有可替换的帧来源。两条传输发的是同一个请求体、打的是同一个地址,差异只在
   * 「帧从哪来」(见 services/api/openaiCompat/sdkTransport.ts 的文件头)。
   *
   * 之所以做成开关而不是直接换掉:这个仓库的历史是「新路第一趟必炸在没想到的地方」,
   * 而一趟 /et 十几席同时死的代价已经付过一次。默认留在 raw,灰度切。
   */
  transport?: 'raw' | 'sdk'
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
   * 自动压缩的**绝对阈值**(token 数)—— 对齐 codex 的 `model_auto_compact_token_limit`。
   *
   * 不写的话阈值是从窗口推出来的(窗口 − 摘要保留 − 缓冲),1M 的窗口推出来是 967000;
   * 写了就按写的这个数触发,但仍**取小**:`min(声明值, 推出来的那个)`。取小不是不信任
   * 用户 —— 压缩本身也是一次带着整段对话的请求,阈值贴着窗口的话被拒的是压缩自己,
   * 而这个 fork 撞上去没有兜底(见 roleContextWindow 的 maxUsefulAutoCompactLimit)。
   *
   * 载入时已经挡掉了「大于那个上限」的值(rolesFromSettings 会记一条诊断并忽略),
   * 所以运行期的取小实际只在**学到的上界**把窗口收小之后才咬合。
   */
  autoCompactTokenLimit?: number
  /**
   * 这个配置是谁的 —— **只用于报错**。
   *
   * 一次 `/et` 跑起来可以有十几个员工同时在说话,而上游失败的那句话如果不点名,用户
   * 拿到的是「某个 openai-responses 员工挂了」,他手上有三个。可选是因为测试和历史配置
   * 里造这个对象的地方不止一处,而缺一个名字不该让报错本身炸掉。
   */
  roleName?: string
}
