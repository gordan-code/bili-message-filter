# B站消息与评论区本地折叠原型

这是一个用于验证筛选思路的 **浏览器用户脚本**，在 B站网页版 `回复我的` 消息页和已适配的网页评论区工作。它**不能改变 B站原生 App 消息页**，也不会在 B站服务器上拉黑、删除或举报任何人。

## 安装和试用

1. 在电脑浏览器安装 Tampermonkey 或 Violentmonkey。
2. 若已安装旧版，打开原脚本编辑器，用 [`bili-message-filter.user.js`](./bili-message-filter.user.js) 的完整内容替换并保存；首次安装才新建脚本，避免两个版本同时运行。
3. 登录 B站网页，打开 `https://message.bilibili.com/#/reply` 或一个有评论区的视频、动态、专栏页面，刷新一次。
4. 疑似消息或评论会显示折叠条。可以“展开”“误判，不再提示此人”或“本地屏蔽此人”。普通留言姓名旁也有“本地屏蔽此人”按钮。
5. 找到确认属于目标头像的评论，点击“以此头像为样本”；同图或近似图随后会折叠。也可从脚本管理器菜单“导入本地头像样本图片”，选择下载到本机的**方形头像原图**（不超过 2 MB）。使用完整立绘或带大量背景的截图通常匹配不到头像裁剪图。
6. 点击“移除此头像样本”可撤销该样本；菜单可清空所有头像样本。手动屏蔽、误判白名单均可撤销，脚本管理器菜单也可切换自动折叠。
7. 可选：若只想隐藏某个对象收到的公开分享，在 B站视频页点击 Tampermonkey 图标，选择“设置视频主评论开头 @对象（留空关闭）”，输入**准确昵称**（带不带 `@` 均可）。留空或点折叠条的“关闭此 @对象规则”即可恢复。此项默认关闭，可能误伤真人对该对象的正常评论。

## 当前识别规则

- 手动屏蔽的 UID：直接折叠。取不到 UID 时，改用精确昵称。
- 作者头像与本地样本的差异哈希接近：标记为疑似。样本由你在 B站网页标记或导入本地图片；不预置网络素材，也不据此断言账号由 AI 操作。
- 昵称包含“鱼”或“鲸”，且评论不少于 35 字：标记为疑似。
- **仅在你主动设置后**：B站视频页的顶层评论正文以精确 `@对象` 开头时折叠；昵称相似但不相同、楼中楼、动态和消息页不触发。这是个人内容偏好规则，**不是 AI 识别证据**。

技术术语规则已删除：正常的技术视频评论也会含有这些词。这些仅是针对截图线索的**粗略候选规则**，不是 AI 账号鉴定；喜欢同一角色的普通用户也可能误命中。白名单优先于自动规则。所有折叠都可逆，不会上传留言、调用 B站互动接口或自动拉黑。

## 范围与已知限制

- 适配网页版 `回复我的`、旧版 `reply-list`／`comment-list` 评论结构，以及新版 `bili-comments` 的开放式 Shadow DOM 主评论和楼中楼。它们出现在视频、动态、专栏等页面时均可处理；**未知结构、closed Shadow Root 和未加载的评论不会被处理**，不能保证字面意义上的每一个 B站页面。
- 主评论单独折叠，不隐藏整串正常回复。筛选名单在脚本运行的各 B站子域中共用；已打开的其他标签页可能需要刷新才能读到最新名单。
- 页面元素选择器参考现有公开脚本，尚未在用户的已登录 B站网页上做人工验收。若 B站改版，可能无效。
- 头像匹配只针对**相同图像及轻微缩放、压缩、裁剪**；不同画作或大幅裁剪无法靠差异哈希识别。图像读取失败时跳过头像规则，不影响手动屏蔽。
- 添加样本后，脚本仅从 `*.hdslb.com/bfs/face/` 读取页面上的头像，在本机计算哈希；并发上限为 3。导入的本地图片不上传。脚本仅保存哈希、UID/昵称名单和开关，不保存头像文件或图片 URL。
- 卸载脚本或清除管理器数据后，本地规则可能丢失。
- 若昵称变更且页面未提供 UID，基于昵称的规则会失效。

## 根据 dsh-bili-whale 的补充判断

该插件的[分享评论代码](https://github.com/Alterssss/dsh-bili-whale/blob/main/tools/commands/comment.mjs)要求主动视频分享正文以配置的 `@owner.name` 开头；其[默认配置](https://github.com/Alterssss/dsh-bili-whale/blob/main/tools/lib/config.mjs)允许自定义账号对应的人设、主人昵称及分享方式，也可改走私信。普通回复不走这一约束。因此没有可靠的“插件专属词汇／头像／评论长度”，更不能看见 `@某人` 就判断为机器人。我们只新增**用户自选的精确 @对象过滤**，不默认开启，不声称覆盖该插件的全部发言。其[项目说明](https://github.com/Alterssss/dsh-bili-whale)还设置了较低的默认分享额度，不能据插件存在就推断特定账号在批量刷屏。

## 开发验证

`npm install` 后运行 `npm test` 和 `npm run check`。本项目使用 Node.js 内置测试框架及 jsdom 26.1.0；实测 Node.js 24。依赖安全检查可运行 `npm audit --audit-level=high --registry=https://registry.npmjs.org`（当前配置的 npmmirror 不支持 npm audit 接口）。

## 参考

- [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)：仅作为问题背景；本脚本不依赖或修改它。
- [既有用户脚本中的 B站回复页 DOM 选择器](https://greasyfork.org/en/scripts/514623-%E5%93%94%E5%93%A9%E5%93%94%E5%93%A9-%E5%B1%8F%E8%94%BD%E6%8C%87%E5%AE%9A%E5%86%85%E5%AE%B9-%E6%94%B91/code)：参考 `.reply-item`、`.name-field a`、`.text` 的结构，未复制其实现。
- [新版评论组件的结构](https://greasyfork.org/zh-CN/scripts/574157-b%E7%AB%99%E8%AF%84%E8%AE%BA%E5%8C%BA%E5%83%B5%E5%B0%B8%E5%8F%B7%E4%B8%80%E9%94%AE%E6%8B%89%E9%BB%91%E5%8A%A9%E6%89%8B-v0-3-5-1-%E8%A1%8C%E4%B8%BA%E5%A2%9E%E5%BC%BA%E7%89%88/code)：参考开放式 Shadow DOM 层级和用户/正文元素，未复制其实现。
- [DeepSeek 鲸鱼娘头像素材示例](https://github.com/phoiex/AAAAGENT/blob/main/assets/original-design/whale-avatar.png)：公开仓库提供 512×512 头像，可下载后手动导入；**不保证**它与截图中的任一 B站头像是同一张图。
- [大肥鱼角色设定](https://github.com/YunYueSama/codex-deepseek-pet/blob/main/docs/%E8%A7%92%E8%89%B2%E8%AE%BE%E5%AE%9A.md)与[同人设定图资源库](https://github.com/xiaoweigen/deepseek-dafeiyu-assets)：帮助确认搜索对象，素材为社区同人，导入或传播前注意来源和许可。完整角色设定图不宜直接充当头像哈希样本。
- [Tampermonkey `@connect` 说明](https://www.tampermonkey.net/documentation.php?q=connect)：脚本把跨域头像读取范围限制在 `hdslb.com` 及其子域。
