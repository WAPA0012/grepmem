// Extended evaluation dataset for Grepmem.
// 50 memories across 10 domains, 80+ test queries across 8 categories.

export const knowledgeBase = [
  // ── Docker/容器 (5) ──────────────────────────────────────────────────────
  {
    summary: 'Redis容器需要端口映射，docker-compose配置ports 6379:6379',
    detail: 'bridge模式下容器有独立网络命名空间，宿主机必须通过端口映射访问容器内服务',
    triggers: ['Redis连接失败或超时', '宿主机无法访问容器服务', '端口映射配置问题'],
  },
  {
    summary: 'Docker同一compose内容器通过service名互相访问',
    detail: '不需要端口映射。容器A用 http://container-b:3000 直接访问容器B',
    triggers: ['容器间网络不通', 'Docker网络配置', 'service名称解析失败', '容器互相访问不了'],
  },
  {
    summary: 'Docker volume数据持久化，容器重启后数据不丢失',
    detail: '使用volumes挂载宿主机目录或named volume。不用volume则容器删除后数据消失',
    triggers: ['容器重启后数据丢失', 'Docker数据持久化', 'volume挂载配置'],
  },
  {
    summary: 'Docker容器内用docker exec -it进入交互式终端',
    detail: 'docker exec -it container_name /bin/sh。Alpine镜像用sh不是bash',
    triggers: ['进入Docker容器内部', '容器内调试命令', 'docker exec使用'],
  },
  {
    summary: 'Docker Compose的depends_on只控制启动顺序不保证服务就绪',
    detail: '需要配合healthcheck或wait-for-it脚本确保依赖服务真正可用。depends_on不会等待数据库完成初始化',
    triggers: ['docker-compose启动顺序问题', '服务启动后连接失败', 'depends_on不等待'],
  },

  // ── Git (5) ──────────────────────────────────────────────────────────────
  {
    summary: 'Git rebase -i可以合并和编辑历史提交',
    detail: '用squash合并多个提交为1个，用reword修改提交信息。push后不要rebase（会改写远程历史）',
    triggers: ['合并多个Git提交', '修改历史提交信息', '清理Git历史'],
  },
  {
    summary: 'Git stash暂存未提交的修改，用于紧急切换分支',
    detail: 'git stash保存工作区和暂存区修改，git stash pop恢复。支持多个stash栈',
    triggers: ['切换分支时有未提交修改', '临时保存当前修改', 'Git stash使用'],
  },
  {
    summary: 'Git cherry-pick从其他分支挑选单个提交到当前分支',
    detail: 'git cherry-pick <commit-hash>。适合将hotfix应用到多个release分支',
    triggers: ['只合并某个提交', '从其他分支摘取提交', 'cherry-pick使用'],
  },
  {
    summary: 'Git merge --no-ff保留分支合并历史',
    detail: '默认fast-forward会丢失分支信息。--no-ff创建merge commit保留完整分支拓扑',
    triggers: ['合并分支后历史丢失', '保留分支合并记录', 'fast-forward vs no-ff'],
  },
  {
    summary: 'Git bisect二分查找引入bug的提交',
    detail: 'git bisect start, git bisect bad, git bisect good <commit>。自动二分定位问题提交',
    triggers: ['找到引入bug的提交', 'Git定位问题代码', '二分查找提交历史'],
  },

  // ── Node.js (5) ──────────────────────────────────────────────────────────
  {
    summary: 'Node.js ES Module需要在package.json设type:module',
    detail: '否则用import语法会报错。也可用.mjs扩展名。CommonJS用require和.cjs',
    triggers: ['import语法报错', 'ES Module配置', 'Cannot use import statement'],
  },
  {
    summary: 'pnpm monorepo用workspace:*引用内部包',
    detail: '在pnpm-workspace.yaml定义packages目录。workspace协议避免手动link',
    triggers: ['monorepo依赖安装失败', 'workspace协议配置', '内部包引用报错'],
  },
  {
    summary: 'Node.js 18+原生支持fetch API和fs/promises',
    detail: '不需要额外装node-fetch。但要注意Node的fetch和浏览器有细微差异',
    triggers: ['Node版本兼容问题', 'fetch is not defined', 'Node新API不可用'],
  },
  {
    summary: 'Node.js流(stream)处理大文件避免内存溢出',
    detail: '用fs.createReadStream管道处理。一次性readFile大文件会爆内存，流式处理只占少量内存',
    triggers: ['读取大文件内存溢出', 'Node流处理', 'stream pipe使用'],
  },
  {
    summary: 'Node.js worker_threads实现CPU密集型任务并行',
    detail: '主线程和worker通过postMessage通信。适合图像处理、加密等CPU密集任务。不适用于IO密集',
    triggers: ['CPU密集任务阻塞主线程', 'Node多线程', 'worker_threads使用'],
  },

  // ── 部署/运维 (5) ───────────────────────────────────────────────────────
  {
    summary: 'Nginx反向代理配置proxy_pass转发到后端服务',
    detail: '注意proxy_set_header传递真实IP和Host。websocket需要Upgrade头配置',
    triggers: ['Nginx反向代理配置', '后端服务502错误', '代理转发不生效'],
  },
  {
    summary: 'SSH连接超时需要检查防火墙和安全组规则',
    detail: '云服务器22端口默认不开放，需在安全组放行。本地防火墙检查iptables/nftables',
    triggers: ['SSH连接超时', '远程服务器连不上', '22端口拒绝连接'],
  },
  {
    summary: 'PM2管理Node.js进程，崩溃自动重启',
    detail: 'pm2 start app.js --name myapp。日志在 ~/.pm2/logs/。ecosystem.config.js配置环境变量',
    triggers: ['Node进程崩溃', 'PM2部署配置', '进程管理工具'],
  },
  {
    summary: 'Docker部署时ENV设置环境变量，不要硬编码配置',
    detail: '用docker-compose的environment或env_file注入。敏感信息用Docker secrets管理',
    triggers: ['Docker环境变量配置', '容器配置硬编码问题', 'Docker secrets使用'],
  },
  {
    summary: 'Nginx配置gzip压缩减少传输体积',
    detail: 'gzip on; gzip_types text/plain application/json。压缩后传输体积减少60-80%',
    triggers: ['网站加载速度慢', 'Nginx性能优化', '响应体太大'],
  },

  // ── 数据库 (5) ──────────────────────────────────────────────────────────
  {
    summary: 'MySQL索引失效的常见原因：函数调用、隐式类型转换、LIKE前缀通配符',
    detail: 'WHERE YEAR(date_col)=2024会导致索引失效。应改为范围查询。VARCHAR字段传整数也会导致隐式转换',
    triggers: ['SQL查询慢', '索引不生效', 'MySQL性能优化', 'EXPLAIN分析'],
  },
  {
    summary: 'PostgreSQL的JSONB类型比JSON更高效，支持索引',
    detail: 'JSONB存储为二进制，查询时不需要重新解析。可以建GIN索引加速JSON字段查询',
    triggers: ['PostgreSQL JSON查询慢', 'JSON数据存储方案', 'JSONB vs JSON'],
  },
  {
    summary: 'Redis缓存击穿用互斥锁或永不过期+异步更新',
    detail: '热点key过期瞬间大量请求打到数据库。用SETNX加锁只让一个请求回源，其他等待',
    triggers: ['缓存击穿', 'Redis热点key失效', '数据库突然压力增大'],
  },
  {
    summary: '数据库连接池大小不是越大越好，推荐CPU核数*2+有效磁盘数',
    detail: '连接过多反而增加上下文切换开销。PostgreSQL默认max_connections=100通常偏高',
    triggers: ['数据库连接数过多', '连接池配置', 'Too many connections错误'],
  },
  {
    summary: 'MongoDB的writeConcern和readConcern控制数据持久性和一致性',
    detail: 'writeConcern: majority确保数据写入大多数节点。readConcern: linearizable最强一致性但性能最低',
    triggers: ['MongoDB数据丢失', '读写一致性配置', 'writeConcern设置'],
  },

  // ── 前端 (5) ────────────────────────────────────────────────────────────
  {
    summary: 'React useEffect的cleanup函数防止内存泄漏',
    detail: '组件卸载时清理定时器、取消订阅、abort fetch请求。否则卸载后仍然更新state会报错',
    triggers: ['React内存泄漏', 'useEffect清理', '组件卸载后setState报错'],
  },
  {
    summary: 'CSS的will-change属性提示浏览器提前优化动画',
    detail: 'will-change: transform让浏览器创建独立图层。但不要滥用，每个图层都消耗内存',
    triggers: ['CSS动画卡顿', '浏览器渲染优化', '动画性能差'],
  },
  {
    summary: 'Webpack tree-shaking依赖ES Module静态分析',
    detail: 'CommonJS的require是动态的无法tree-shake。确保package.json设sideEffects:false',
    triggers: ['打包体积过大', 'tree-shaking不生效', 'Webpack优化'],
  },
  {
    summary: '浏览器同源策略限制跨域请求，CORS需要服务端配置',
    detail: 'Access-Control-Allow-Origin设置允许的源。预检请求OPTIONS需要正确响应',
    triggers: ['跨域请求被拦截', 'CORS错误', 'OPTIONS请求失败'],
  },
  {
    summary: 'React.memo和useMemo优化不必要的重渲染',
    detail: 'React.memo对组件做浅比较。useMemo缓存计算结果。但不要过度优化，先profile再优化',
    triggers: ['React渲染性能差', '组件频繁重渲染', 'React性能优化'],
  },

  // ── 安全 (5) ────────────────────────────────────────────────────────────
  {
    summary: 'SQL注入防护使用参数化查询，不要拼接SQL字符串',
    detail: 'prepared statement或ORM参数绑定。永不信信任用户输入。mysql2的?占位符',
    triggers: ['SQL注入防护', '数据库安全问题', '用户输入过滤'],
  },
  {
    summary: 'JWT token应该设置合理过期时间，refresh token轮换',
    detail: 'access token 15分钟，refresh token 7天。refresh token每次使用后轮换，旧token失效',
    triggers: ['JWT安全配置', 'token过期策略', 'refresh token实现'],
  },
  {
    summary: 'HTTPS不是万能的，仍需设置CSP、X-Frame-Options等安全头',
    detail: 'Content-Security-Policy防XSS。X-Frame-Options防点击劫持。HSTS强制HTTPS',
    triggers: ['网站安全头配置', 'XSS防护', 'CSP策略'],
  },
  {
    summary: '密码存储用bcrypt或argon2，永远不要用MD5/SHA1',
    detail: 'bcrypt自动加盐，cost factor控制计算强度。argon2是密码竞赛冠军，抗GPU/ASIC攻击',
    triggers: ['密码存储安全', '哈希算法选择', '用户密码加密'],
  },
  {
    summary: 'API速率限制防止暴力破解和DDoS',
    detail: '按IP或用户ID限制请求频率。express-rate-limit或Nginx limit_req。429状态码',
    triggers: ['API被暴力攻击', '接口限流', '速率限制配置'],
  },

  // ── 调试/排障 (5) ──────────────────────────────────────────────────────
  {
    summary: 'Chrome DevTools远程调试Node.js：node --inspect',
    detail: '打开chrome://inspect连接。可断点、看调用栈、检查变量。也支持远程服务器调试',
    triggers: ['Node.js调试', '远程调试配置', '--inspect使用'],
  },
  {
    summary: '内存泄漏排查用heapdump和Chrome DevTools Memory面板',
    detail: '拍两次heap snapshot对比差异。关注Detached DOM节点和持续增长的闭包',
    triggers: ['内存泄漏排查', 'Node内存持续增长', 'heap snapshot分析'],
  },
  {
    summary: 'Linux下用strace追踪系统调用定位问题',
    detail: 'strace -p <pid>追踪进程。看open/read/write/connect调用。strace -e trace=network只看网络',
    triggers: ['Linux进程排查', '系统调用追踪', '进程卡住不动'],
  },
  {
    summary: 'DNS解析问题用nslookup和dig排查',
    detail: 'nslookup domain.com。dig domain.com +trace追踪完整解析链路。TTL缓存导致解析延迟',
    triggers: ['域名解析失败', 'DNS配置问题', '网站打不开但IP可以'],
  },
  {
    summary: 'HTTP抓包用tcpdump或mitmproxy分析请求响应',
    detail: 'tcpdump -i any port 80 -w dump.pcap。mitmproxy支持HTTPS解密。Wireshark可视化分析',
    triggers: ['HTTP请求排查', '抓包分析', '接口请求响应不对'],
  },

  // ── CI/CD (5) ──────────────────────────────────────────────────────────
  {
    summary: 'GitHub Actions缓存node_modules加速CI构建',
    detail: 'actions/cache缓存~/.npm或node_modules。key用lock文件hash。恢复缓存命中可减少50%构建时间',
    triggers: ['CI构建太慢', 'GitHub Actions优化', 'node_modules缓存'],
  },
  {
    summary: 'Docker多阶段构建减小镜像体积',
    detail: '编译阶段用完整镜像，运行阶段用alpine。最终镜像可以从1GB+降到50MB以下',
    triggers: ['Docker镜像太大', '镜像体积优化', '多阶段构建'],
  },
  {
    summary: '蓝绿部署和滚动部署对比：蓝绿零停机但需要双倍资源',
    detail: '蓝绿部署切换流量到新版本，出问题立即回切。滚动部署逐步替换，节省资源但有兼容窗口',
    triggers: ['部署策略选择', '零停机部署', '蓝绿部署 vs 滚动部署'],
  },
  {
    summary: 'GitLab CI的rules关键字控制流水线触发条件',
    detail: 'rules: if判断分支和变量。changes判断文件变更。只有匹配条件才运行job',
    triggers: ['GitLab CI流水线配置', 'CI触发条件', 'rules关键字使用'],
  },
  {
    summary: '语义化版本(SemVer)：MAJOR.MINOR.PATCH',
    detail: 'MAJOR不兼容变更，MINOR向后兼容新功能，PATCH向后兼容修复。npm包遵循SemVer',
    triggers: ['版本号规则', 'npm包版本管理', '语义化版本'],
  },
];

export const testCases = [
  // ── Category 1: 精确触发 (10) ─────────────────────────────────────────
  { category: '精确触发', query: 'Redis连接失败', expectContains: 'Redis', desc: 'trigger原话' },
  { category: '精确触发', query: 'Git stash使用', expectContains: 'stash', desc: 'trigger关键词' },
  { category: '精确触发', query: 'Nginx反向代理配置', expectContains: 'Nginx', desc: 'trigger原话' },
  { category: '精确触发', query: 'SQL注入防护', expectContains: 'SQL注入', desc: 'trigger原话' },
  { category: '精确触发', query: 'Docker数据持久化', expectContains: 'volume', desc: 'trigger关键词' },
  { category: '精确触发', query: 'API被暴力攻击', expectContains: '速率限制', desc: 'trigger命中' },
  { category: '精确触发', query: '跨域请求被拦截', expectContains: 'CORS', desc: 'trigger关键词' },
  { category: '精确触发', query: 'React渲染性能差', expectContains: 'React', desc: 'trigger原话' },
  { category: '精确触发', query: '蓝绿部署 vs 滚动部署', expectContains: '蓝绿', desc: 'trigger关键词' },
  { category: '精确触发', query: 'DNS配置问题', expectContains: 'DNS', desc: 'trigger关键词' },

  // ── Category 2: 同义/语义匹配 (15) ─────────────────────────────────────
  { category: '语义匹配', query: '缓存挂了', expectContains: 'Redis', desc: '缓存→Redis' },
  { category: '语义匹配', query: '怎么把好几个commit合成一个', expectContains: 'rebase', desc: '合并提交→rebase' },
  { category: '语义匹配', query: '服务器连不上了', expectContains: 'SSH', desc: '连不上→SSH' },
  { category: '语义匹配', query: 'import报错了', expectContains: 'ES Module', desc: 'import→ESM' },
  { category: '语义匹配', query: '网页打不开后端报502', expectContains: 'Nginx', desc: '502→反向代理' },
  { category: '语义匹配', query: '容器里数据没了', expectContains: 'volume', desc: '数据没了→持久化' },
  { category: '语义匹配', query: '数据库查询越来越慢', expectContains: '索引', desc: '查询慢→索引' },
  { category: '语义匹配', query: '密码怎么安全存储', expectContains: 'bcrypt', desc: '密码存储→bcrypt' },
  { category: '语义匹配', query: 'token多久过期合适', expectContains: 'JWT', desc: 'token过期→JWT' },
  { category: '语义匹配', query: '打包后文件太大', expectContains: 'tree-shaking', desc: '打包大→tree-shake' },
  { category: '语义匹配', query: 'Node进程挂了怎么自动恢复', expectContains: 'PM2', desc: '进程挂→PM2' },
  { category: '语义匹配', query: '怎么找到是哪次提交引入的bug', expectContains: 'bisect', desc: '找bug提交→bisect' },
  { category: '语义匹配', query: '前端动画一卡一卡的', expectContains: 'will-change', desc: '动画卡→CSS优化' },
  { category: '语义匹配', query: '大文件读取内存爆了', expectContains: 'stream', desc: '大文件→流处理' },
  { category: '语义匹配', query: '网站不安全怎么加固', expectContains: '安全头', desc: '安全加固→安全头' },

  // ── Category 3: 跨领域联想 (8) ─────────────────────────────────────────
  { category: '跨领域', query: 'Docker里Redis连不上', expectContains: 'Redis', desc: '应命中Redis端口映射' },
  { category: '跨领域', query: '服务访问不了怎么办', expectContains: null, desc: '广泛查询，至少1个结果' },
  { category: '跨领域', query: '线上出了问题怎么排查', expectContains: null, desc: '非常宽泛，至少1个' },
  { category: '跨领域', query: 'Docker镜像太大了部署慢', expectContains: '多阶段', desc: '镜像大→多阶段构建' },
  { category: '跨领域', query: 'CI跑一次太慢了', expectContains: '缓存', desc: 'CI慢→缓存加速' },
  { category: '跨领域', query: '数据库连接经常断', expectContains: '连接池', desc: '连接断→连接池配置' },
  { category: '跨领域', query: '接口被人刷了怎么办', expectContains: '速率限制', desc: '接口被刷→限流' },
  { category: '跨领域', query: 'MongoDB写入后读不到', expectContains: 'writeConcern', desc: '写入后读不到→一致性' },

  // ── Category 4: 无关查询 (5) ───────────────────────────────────────────
  { category: '无关查询', query: '今天天气怎么样', expectContains: null, expectEmpty: true, desc: '完全无关' },
  { category: '无关查询', query: '推荐一部电影', expectContains: null, expectEmpty: true, desc: '完全无关' },
  { category: '无关查询', query: '红烧肉怎么做', expectContains: null, expectEmpty: true, desc: '完全无关' },
  { category: '无关查询', query: 'NBA总决赛谁赢了', expectContains: null, expectEmpty: true, desc: '完全无关' },
  { category: '无关查询', query: '学英语用什么APP', expectContains: null, expectEmpty: true, desc: '完全无关' },

  // ── Category 5: Summary/detail回调 (8) ─────────────────────────────────
  { category: 'Summary回调', query: 'Alpine镜像没有bash', expectContains: 'docker exec', desc: 'Alpine→容器exec' },
  { category: 'Summary回调', query: 'heap snapshot怎么拍', expectContains: '内存泄漏', desc: 'heapdump→内存排查' },
  { category: 'Summary回调', query: 'websocket代理配置', expectContains: 'Nginx', desc: 'websocket→反向代理' },
  { category: 'Summary回调', query: 'ecosystem.config.js怎么写', expectContains: 'PM2', desc: '配置文件→PM2' },
  { category: 'Summary回调', query: 'wait-for-it脚本是什么', expectContains: 'depends_on', desc: 'wait-for-it→启动顺序' },
  { category: 'Summary回调', query: 'GIN索引是什么', expectContains: 'JSONB', desc: 'GIN→PostgreSQL JSONB' },
  { category: 'Summary回调', query: '什么是上下文切换', expectContains: '连接池', desc: '上下文切换→连接池' },
  { category: 'Summary回调', query: 'X-Frame-Options防什么攻击', expectContains: '安全头', desc: 'X-Frame-Options→CSP' },

  // ── Category 6: 模糊/口语化 (6) ────────────────────────────────────────
  { category: '模糊查询', query: '代码合出问题了', expectContains: 'merge', desc: '合代码→merge' },
  { category: '模糊查询', query: '网站好慢啊', expectContains: null, desc: '模糊慢，至少1个性能相关' },
  { category: '模糊查询', query: '部署又挂了', expectContains: null, desc: '模糊部署，至少1个' },
  { category: '模糊查询', query: '密码忘了咋办', expectContains: '密码', desc: '密码→密码存储' },
  { category: '模糊查询', query: '前端又炸了', expectContains: null, desc: '模糊前端，至少1个' },
  { category: '模糊查询', query: '数据库卡死了', expectContains: null, desc: '模糊数据库，至少1个' },

  // ── Category 7: 多意图查询 (5) ─────────────────────────────────────────
  { category: '多意图', query: 'Docker部署Node怎么配置', expectContains: 'Docker', desc: 'Docker+Node' },
  { category: '多意图', query: 'Git和CI怎么配合', expectContains: null, desc: 'Git+CI，至少1个' },
  { category: '多意图', query: '前端安全怎么做', expectContains: '安全头', desc: '前端+安全→CSP' },
  { category: '多意图', query: '数据库和缓存一致性问题', expectContains: 'Redis', desc: 'DB+缓存→Redis缓存' },
  { category: '多意图', query: 'Node部署后进程管理', expectContains: 'PM2', desc: 'Node+部署→PM2' },

  // ── Category 8: 近义/拼写变体 (6) ──────────────────────────────────────
  { category: '近义变体', query: 'dockers compose启动有问题', expectContains: 'depends_on', desc: 'docker-compose→启动顺序' },
  { category: '近义变体', query: 'pgsql的json字段查询', expectContains: 'JSONB', desc: 'pgsql→PostgreSQL' },
  { category: '近义变体', query: 'react组件重新渲染太多', expectContains: 'memo', desc: '重新渲染→React.memo' },
  { category: '近义变体', query: 'nginx反向代理websocket', expectContains: 'Nginx', desc: 'nginx→Nginx代理' },
  { category: '近义变体', query: '怎么查看dns解析', expectContains: 'nslookup', desc: 'dns→DNS排查' },
  { category: '近义变体', query: 'mongo写入有问题', expectContains: 'MongoDB', desc: 'mongo→MongoDB' },
];
