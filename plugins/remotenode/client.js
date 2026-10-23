// ============================================================
// @dsh-design/remotenode —— Client 半端（浏览器 ModuleLoader bundle）
//
// 两个落点，共用同一份 Host 数据（/api/remotenode/*，契约见 SPEC.md §7）：
//   1) sidebar.panellist「远程节点」：侧栏全局面板入口（id=remotenode）；
//   2) main keyed 面板（key=remotenode）：主面板。
//
// 主面板内容：
//   - 顶栏：标题、本机 nodeId / 监听地址、刷新（POST /refresh）、新建远程会话、
//     发布交付物；
//   - 链路：每个 peer 的状态点 / 方向 / RTT / 最近心跳；
//   - 会话：两组（我发起·运行在对端 / 对端发起·运行在本机），点击进入详情；
//   - 会话详情：返回、状态徽标、转录滚动区（user / assistant / tool-call /
//     tool-result / 交付物）、prompt 输入（Ctrl/Cmd+Enter 发送）、取消按钮、
//     2 秒轮询；
//   - 交付物：按 link 分组，状态 / 大小 / 版本，拉取（POST /artifact/fetch）、
//     下载与图片预览（GET /artifact?key=）。
//
// 约束（与 dsh-server-monitor / dsh-memory 保持一致）：
//   - 除 require('react') 外不 import 任何模块，不操作 document.body；
//   - 样式只使用宿主主题 token（--dsw-alias-*），类名前缀 rn-，
//     通过一个 React <style> 元素注入；
//   - 所有渲染路径对脏数据保持防御：任何字段缺失 / 接口失败都只影响局部，
//     不让插槽条目崩掉（条目崩溃会白屏）；
//   - 所有请求都带 cache: 'no-store'，失败继续轮询。
// ============================================================
window.__ModuleLoader__.load({
  id: '@dsh-design/remotenode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useRef = React.useRef

    /** 本地化命名空间。 */
    const NS = 'remotenode'
    /** Host HTTP API 前缀。 */
    const API = '/api/remotenode'
    /** 面板轮询间隔（SPEC §8：2s）。 */
    const POLL_MS = 2000
    /** 单个事件文本渲染上限（Host 已裁剪到 4000，这里再兜底一次）。 */
    const MAX_EVENT_TEXT = 12000

    // ------------------------------------------------------------
    // 文案字典（zh 为回退语言；en 与 zh 键集合必须一致）
    // ------------------------------------------------------------
    const ZH = {
      nav: '远程节点',
      title: '远程节点',
      subtitle: '对等链路、远程会话与交付物',
      refresh: '刷新',
      refreshing: '刷新中…',
      newSession: '新建远程会话',
      publish: '发布交付物',
      publishTitle: '发布本地文件为交付物',
      loadingState: '正在读取远程节点状态…',
      stateError: '状态读取失败',
      retryHint: '（每 2 秒自动重试）',
      dismiss: '关闭',
      links: '链路',
      noPeers: '尚未配置对端',
      noPeersHint: '编辑 $DSH_HOME/remotenode/config.json 的 peers 数组（nodeId / host / port / secret），重启 DSH 后点击「刷新」。',
      sessions: '会话',
      outboundGroup: '我发起的（运行在对端）',
      inboundGroup: '对端发起的（运行在本机）',
      noOutbound: '暂无我发起的会话',
      noInbound: '暂无对端发起的会话',
      deliverables: '交付物',
      noDeliverables: '暂无交付物',
      peer: '对端',
      initialPrompt: '初始 Prompt（可选）',
      initialPromptPlaceholder: '例如：帮我看一下这台机器的磁盘使用情况',
      start: '创建会话',
      starting: '创建中…',
      promptPlaceholder: '输入要发送给远程会话的消息…',
      sendHint: 'Ctrl / ⌘ + Enter 发送',
      send: '发送',
      sending: '发送中…',
      promptSent: '消息已发送',
      cancel: '取消',
      cancelRun: '取消运行',
      cancelling: '取消中…',
      cancelRequested: '已请求取消',
      back: '返回',
      sessionDetail: '会话详情',
      sessionIdLabel: '会话',
      loadingTranscript: '正在加载转录…',
      noTranscript: '暂无转录事件；在下方输入消息即可开始对话。',
      fetch: '拉取',
      fetching: '拉取中…',
      fetched: '拉取完成',
      download: '下载',
      preview: '预览',
      version: '版本',
      origin: '来源',
      unknownTool: '工具',
      toolResult: '工具结果',
      deliverablesPresented: '交付物已发布',
      noFiles: '（无文件信息）',
      roleUser: '用户',
      roleAssistant: '助手',
      roleToolCall: '工具调用',
      roleToolResult: '工具结果',
      roleDeliverable: '交付物',
      roleTurn: '轮次',
      roleEvent: '事件',
      turnStart: '回合开始',
      turnEnd: '回合结束',
      emptyText: '（空）',
      untitledSession: '未命名会话',
      unknownPeer: '未知对端',
      listen: '监听',
      notListening: '未监听',
      dataDir: '数据目录',
      self: '本机',
      updatedAt: '更新于',
      direction: '方向',
      directionOut: '主动拨出',
      directionIn: '对端拨入',
      sessionDirectionOut: '我发起',
      sessionDirectionIn: '对端发起',
      rtt: 'RTT',
      lastSeen: '最近心跳',
      justNow: '刚刚',
      secondsShort: '秒',
      minutesShort: '分钟',
      hoursShort: '小时',
      agoSuffix: '前',
      online: '在线',
      offline: '离线',
      dialing: '拨号中',
      errorState: '错误',
      unknownState: '未知',
      running: '运行中',
      idle: '空闲',
      startingState: '启动中',
      syncMetadata: '仅元数据',
      syncFetching: '拉取中',
      syncSynced: '已同步',
      syncError: '同步失败',
      kindImage: '图片',
      kindModel: '模型',
      kindFile: '文件',
      publishPath: '本地文件路径（执行侧可读）',
      publishPathPlaceholder: '例如 /tmp/output/cat.png',
      publishDescription: '描述（可选）',
      publishDescriptionPlaceholder: '例如：远程节点生成的预览图',
      doPublish: '发布',
      publishing: '发布中…',
      published: '已发布交付物',
      noPeerForAction: '没有可选择的对端（请先配置 peers）',
      needPath: '请填写要发布的本地文件路径',
      eventsLabel: '事件',
      deliverableCountLabel: '交付物',
      loadFailed: '读取失败',
      renderFailed: '远程节点面板渲染失败',
      detailRenderFailed: '会话详情渲染失败',
      sessionGone: '会话可能已不存在，请返回列表刷新。',
      emptyValue: '—',
      configFileHint: '$DSH_HOME/remotenode/config.json',
      configWarnings: '配置警告',
      pairingTitle: '配对令牌',
      pairingHint: '在对端面板的「配对令牌」中复制该令牌即可完成配对。',
      fingerprint: '指纹',
      showToken: '显示',
      hideToken: '隐藏',
      copyToken: '复制',
      copied: '已复制',
      copyFailed: '复制失败，请手动选择令牌复制',
      rotateToken: '轮换',
      rotating: '轮换中…',
      tokenRotated: '配对令牌已轮换',
      fixedByConfig: '令牌由 config.json 固定，不可轮换',
      addNode: '添加节点',
      addNodeTitle: '添加远程节点',
      addNodeHint: '输入对端的地址、端口与对端面板显示的配对令牌。配对可能需要几秒钟，请勿重复提交。',
      nodeNameOptional: '名称（可选）',
      nodeNamePlaceholder: '例如：台式机 worker',
      nodeAddress: '地址（IP / 域名）',
      nodeAddressPlaceholder: '例如：10.0.0.5 或 desktop.example.com',
      nodePort: '端口',
      nodePortPlaceholder: '例如：47301',
      nodeToken: '配对令牌',
      nodeTokenPlaceholder: '粘贴对端面板显示的配对令牌',
      startPairing: '发起配对',
      pairing: '配对中…',
      pairSuccess: '已添加节点',
      needHost: '请填写对端地址',
      needPort: '请填写有效端口（1-65535）',
      needToken: '请填写配对令牌',
      pendingPairs: '配对请求',
      pendingPairsHint: '以下节点正在请求与本机配对，批准后会建立并持久化链路。',
      pendingFrom: '来源',
      listenPortLabel: '监听端口',
      approve: '批准',
      reject: '拒绝',
      approving: '批准中…',
      rejecting: '拒绝中…',
      pairApproved: '已批准配对',
      pairRejected: '已拒绝配对',
      sourceLabel: '来源',
      sourceConfig: '配置',
      sourcePaired: '已配对',
      removeNode: '删除',
      removeConfirm: '删除该节点？',
      removeConfirmHint: '将关闭链路并删除已持久化的节点。',
      confirmRemove: '确认删除',
      removing: '删除中…',
      nodeRemoved: '已删除节点',
      listenTitle: '监听',
      listenDisabled: '已关闭',
      listenHint: '对等监听用于接受其它节点的连接；从这里修改会立即生效（无需重启 DSH）。',
      listenEnabledLabel: '启用对等监听',
      listenSourcePrefix: '来源',
      listenSourceSettings: '面板设置',
      listenSourceConfig: '配置文件',
      listenSourceDefault: '默认',
      listenEdit: '修改',
      listenEditTitle: '修改监听设置',
      listenEditHint: '127.0.0.1 / localhost 只允许本机连接；要允许其它节点从外部接入，请绑定 0.0.0.0 或具体网卡 IP，并在防火墙放行该端口。',
      listenHostLabel: '绑定地址（IP / 主机名）',
      listenHostPlaceholder: '例如：127.0.0.1 或 0.0.0.0',
      listenHostHint: '127.0.0.1 / localhost 仅本机；0.0.0.0 或具体网卡 IP 才可被外部连接。',
      listenPortLabel: '端口',
      listenPortPlaceholder: '例如：47201',
      listenExternalWarning: '当前绑定地址可被外部网络连接：请确认防火墙只放行可信来源，并注意密钥与配对令牌安全。',
      needListenHost: '请填写绑定地址',
      needListenPort: '请填写有效端口（1-65535）',
      listenSave: '保存',
      listenSaving: '保存中…',
      listenSaved: '监听设置已保存',
      listenReset: '恢复配置文件设置',
      listenResetDone: '已恢复为配置文件中的监听设置',
      listenResetFailed: '恢复监听设置失败',
    }
    const EN = {
      nav: 'Remote node',
      title: 'Remote node',
      subtitle: 'Peer links, remote sessions and deliverables',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      newSession: 'New remote session',
      publish: 'Publish deliverable',
      publishTitle: 'Publish a local file as a deliverable',
      loadingState: 'Reading remote-node state…',
      stateError: 'Failed to read state',
      retryHint: '(retrying every 2 seconds)',
      dismiss: 'Dismiss',
      links: 'Links',
      noPeers: 'No peers configured',
      noPeersHint: 'Edit the peers array (nodeId / host / port / secret) in $DSH_HOME/remotenode/config.json, restart DSH and click "Refresh".',
      sessions: 'Sessions',
      outboundGroup: 'Started by me (running on the peer)',
      inboundGroup: 'Started by the peer (running here)',
      noOutbound: 'No sessions started by me',
      noInbound: 'No sessions started by the peer',
      deliverables: 'Deliverables',
      noDeliverables: 'No deliverables',
      peer: 'Peer',
      initialPrompt: 'Initial prompt (optional)',
      initialPromptPlaceholder: 'e.g. check disk usage on this machine',
      start: 'Start session',
      starting: 'Starting…',
      promptPlaceholder: 'Message to send to the remote session…',
      sendHint: 'Ctrl / ⌘ + Enter to send',
      send: 'Send',
      sending: 'Sending…',
      promptSent: 'Message sent',
      cancel: 'Cancel',
      cancelRun: 'Cancel run',
      cancelling: 'Cancelling…',
      cancelRequested: 'Cancellation requested',
      back: 'Back',
      sessionDetail: 'Session detail',
      sessionIdLabel: 'Session',
      loadingTranscript: 'Loading transcript…',
      noTranscript: 'No transcript events yet; type a message below to start.',
      fetch: 'Fetch',
      fetching: 'Fetching…',
      fetched: 'Fetched',
      download: 'Download',
      preview: 'Preview',
      version: 'Version',
      origin: 'Origin',
      unknownTool: 'tool',
      toolResult: 'Tool result',
      deliverablesPresented: 'Deliverables presented',
      noFiles: '(no file info)',
      roleUser: 'User',
      roleAssistant: 'Assistant',
      roleToolCall: 'Tool call',
      roleToolResult: 'Tool result',
      roleDeliverable: 'Deliverable',
      roleTurn: 'Turn',
      roleEvent: 'Event',
      turnStart: 'Turn started',
      turnEnd: 'Turn ended',
      emptyText: '(empty)',
      untitledSession: 'Untitled session',
      unknownPeer: 'Unknown peer',
      listen: 'Listening',
      notListening: 'not listening',
      dataDir: 'Data dir',
      self: 'This node',
      updatedAt: 'Updated',
      direction: 'Direction',
      directionOut: 'Dialed out',
      directionIn: 'Dialed in',
      sessionDirectionOut: 'Started by me',
      sessionDirectionIn: 'Started by peer',
      rtt: 'RTT',
      lastSeen: 'Last heartbeat',
      justNow: 'just now',
      secondsShort: 's ',
      minutesShort: 'm ',
      hoursShort: 'h ',
      agoSuffix: 'ago',
      online: 'Online',
      offline: 'Offline',
      dialing: 'Dialing',
      errorState: 'Error',
      unknownState: 'Unknown',
      running: 'Running',
      idle: 'Idle',
      startingState: 'Starting',
      syncMetadata: 'Metadata only',
      syncFetching: 'Fetching',
      syncSynced: 'Synced',
      syncError: 'Sync error',
      kindImage: 'Image',
      kindModel: 'Model',
      kindFile: 'File',
      publishPath: 'Local file path (readable on the executing side)',
      publishPathPlaceholder: 'e.g. /tmp/output/cat.png',
      publishDescription: 'Description (optional)',
      publishDescriptionPlaceholder: 'e.g. preview image from the remote node',
      doPublish: 'Publish',
      publishing: 'Publishing…',
      published: 'Deliverable published',
      noPeerForAction: 'No peer available (configure peers first)',
      needPath: 'Enter the local file path to publish',
      eventsLabel: 'events',
      deliverableCountLabel: 'deliverables',
      loadFailed: 'Failed to load',
      renderFailed: 'Remote node panel failed to render',
      detailRenderFailed: 'Session detail failed to render',
      sessionGone: 'The session may no longer exist; go back and refresh the list.',
      emptyValue: '—',
      configFileHint: '$DSH_HOME/remotenode/config.json',
      configWarnings: 'Config warnings',
      pairingTitle: 'Pairing token',
      pairingHint: 'Copy this token from the peer\'s "Pairing token" section to pair.',
      fingerprint: 'Fingerprint',
      showToken: 'Show',
      hideToken: 'Hide',
      copyToken: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed, select the token manually',
      rotateToken: 'Rotate',
      rotating: 'Rotating…',
      tokenRotated: 'Pairing token rotated',
      fixedByConfig: 'Token is fixed by config.json and cannot be rotated',
      addNode: 'Add node',
      addNodeTitle: 'Add remote node',
      addNodeHint: 'Enter the peer address, port and the pairing token shown on its panel. Pairing may take a few seconds; do not submit twice.',
      nodeNameOptional: 'Name (optional)',
      nodeNamePlaceholder: 'e.g. Desktop worker',
      nodeAddress: 'Address (IP / hostname)',
      nodeAddressPlaceholder: 'e.g. 10.0.0.5 or desktop.example.com',
      nodePort: 'Port',
      nodePortPlaceholder: 'e.g. 47301',
      nodeToken: 'Pairing token',
      nodeTokenPlaceholder: 'Paste the pairing token shown on the peer panel',
      startPairing: 'Pair',
      pairing: 'Pairing…',
      pairSuccess: 'Node added',
      needHost: 'Enter the peer address',
      needPort: 'Enter a valid port (1-65535)',
      needToken: 'Enter the pairing token',
      pendingPairs: 'Pairing requests',
      pendingPairsHint: 'These peers are requesting to pair with this node; approving creates and persists the link.',
      pendingFrom: 'From',
      listenPortLabel: 'Listen port',
      approve: 'Approve',
      reject: 'Reject',
      approving: 'Approving…',
      rejecting: 'Rejecting…',
      pairApproved: 'Pairing approved',
      pairRejected: 'Pairing rejected',
      sourceLabel: 'Source',
      sourceConfig: 'Config',
      sourcePaired: 'Paired',
      removeNode: 'Remove',
      removeConfirm: 'Remove this node?',
      removeConfirmHint: 'This closes the link and deletes the persisted peer.',
      confirmRemove: 'Confirm remove',
      removing: 'Removing…',
      nodeRemoved: 'Node removed',
      listenTitle: 'Listener',
      listenDisabled: 'Disabled',
      listenHint: 'The peer listener accepts connections from other nodes; changes here apply immediately without restarting DSH.',
      listenEnabledLabel: 'Enable peer listener',
      listenSourcePrefix: 'Source',
      listenSourceSettings: 'Panel settings',
      listenSourceConfig: 'Config file',
      listenSourceDefault: 'Default',
      listenEdit: 'Edit',
      listenEditTitle: 'Edit listen settings',
      listenEditHint: '127.0.0.1 / localhost accepts local connections only. To let remote peers connect, bind 0.0.0.0 or a specific interface IP and open the port in your firewall.',
      listenHostLabel: 'Bind address (IP / hostname)',
      listenHostPlaceholder: 'e.g. 127.0.0.1 or 0.0.0.0',
      listenHostHint: '127.0.0.1 / localhost = local only; 0.0.0.0 or an interface IP is externally reachable.',
      listenPortLabel: 'Port',
      listenPortPlaceholder: 'e.g. 47201',
      listenExternalWarning: 'This bind address is reachable from the network: make sure your firewall only exposes it to trusted sources and keep secrets and pairing tokens safe.',
      needListenHost: 'Enter a bind address',
      needListenPort: 'Enter a valid port (1-65535)',
      listenSave: 'Save',
      listenSaving: 'Saving…',
      listenSaved: 'Listen settings saved',
      listenReset: 'Restore config setting',
      listenResetDone: 'Restored the listen settings from the config file',
      listenResetFailed: 'Failed to restore listen settings',
    }

    /** 当前翻译函数；locale 服务就绪前用 zh 回退。 */
    let translate = null
    function t(key) {
      if (typeof translate === 'function') {
        try {
          const text = translate(key)
          if (typeof text === 'string' && text !== '' && text !== key) return text
        } catch (error) {
          // 翻译服务异常时继续用回退字典。
        }
      }
      if (typeof ZH[key] === 'string') return ZH[key]
      if (typeof EN[key] === 'string') return EN[key]
      return String(key)
    }

    // ------------------------------------------------------------
    // 基础工具：全部容错，渲染期绝不因脏数据抛异常
    // ------------------------------------------------------------
    function isObject(value) {
      return value !== null && typeof value === 'object'
    }
    function asArray(value) {
      return Array.isArray(value) ? value : []
    }
    function asText(value, fallback) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && isFinite(value)) return String(value)
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return typeof fallback === 'string' ? fallback : ''
    }
    function numOrNull(value) {
      if (value === null || value === undefined || value === '') return null
      const num = Number(value)
      return isFinite(num) ? num : null
    }
    function textOr(value, fallback) {
      const text = asText(value)
      return text === '' ? fallback : text
    }
    function pad2(value) {
      return value < 10 ? '0' + String(value) : String(value)
    }
    /** 错误对象 → 可展示文本；绝不抛出。 */
    function errText(error) {
      try {
        if (error && typeof error.message === 'string' && error.message) return error.message
        if (typeof error === 'string' && error) return error
        if (isObject(error)) return JSON.stringify(error).slice(0, 300)
      } catch (ignore) {
        // 落到下面的默认文案。
      }
      return t('loadFailed')
    }
    /** 时钟：HH:mm:ss（无效输入返回 '—'）。 */
    function fmtClock(value) {
      const num = numOrNull(value)
      if (num === null || num <= 0) return t('emptyValue')
      const date = new Date(num)
      if (isNaN(date.getTime())) return t('emptyValue')
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
    }
    /** 日期时间：MM-DD HH:mm:ss。 */
    function fmtDateTime(value) {
      const num = numOrNull(value)
      if (num === null || num <= 0) return t('emptyValue')
      const date = new Date(num)
      if (isNaN(date.getTime())) return t('emptyValue')
      return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
        + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }
    /** 相对时间：刚刚 / N 秒前 / N 分钟前 / N 小时前 / 日期。 */
    function fmtAgo(value) {
      const num = numOrNull(value)
      if (num === null || num <= 0) return t('emptyValue')
      const diff = Date.now() - num
      if (!isFinite(diff)) return fmtClock(num)
      if (diff < 0) return fmtDateTime(num)
      if (diff < 5000) return t('justNow')
      const secs = Math.floor(diff / 1000)
      if (secs < 60) return String(secs) + t('secondsShort') + t('agoSuffix')
      const mins = Math.floor(secs / 60)
      if (mins < 60) return String(mins) + t('minutesShort') + t('agoSuffix')
      const hours = Math.floor(mins / 60)
      if (hours < 24) return String(hours) + t('hoursShort') + t('agoSuffix')
      return fmtDateTime(num)
    }
    /** 字节大小（1024 进制）。 */
    function fmtBytes(value) {
      const num = numOrNull(value)
      if (num === null || num <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let size = num
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      const digits = size >= 100 || index === 0 ? 0 : size >= 10 ? 1 : 2
      const factor = Math.pow(10, digits)
      return String(Math.round(size * factor) / factor) + ' ' + units[index]
    }
    /** 截断 id 展示（完整值放 title）。 */
    function shortId(value, max) {
      const text = asText(value)
      if (text === '') return ''
      const limit = typeof max === 'number' && max > 8 ? max : 30
      return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
    }
    /** 事件文本兜底裁剪。 */
    function clipText(value) {
      const text = asText(value)
      if (text === '') return t('emptyText')
      return text.length > MAX_EVENT_TEXT ? text.slice(0, MAX_EVENT_TEXT) + '…' : text
    }

    // ------------------------------------------------------------
    // 状态文案 / 样式映射
    // ------------------------------------------------------------
    function peerStateText(state) {
      if (state === 'online') return t('online')
      if (state === 'dialing') return t('dialing')
      if (state === 'error') return t('errorState')
      if (state === 'offline') return t('offline')
      return t('unknownState')
    }
    function peerDotClass(state) {
      if (state === 'online') return 'rn-dot rn-dot-online'
      if (state === 'dialing') return 'rn-dot rn-dot-dialing'
      if (state === 'error') return 'rn-dot rn-dot-error'
      return 'rn-dot rn-dot-offline'
    }
    function sessionStateText(state) {
      if (state === 'running') return t('running')
      if (state === 'starting') return t('startingState')
      if (state === 'idle') return t('idle')
      if (state === 'offline') return t('offline')
      if (state === 'error') return t('errorState')
      return t('unknownState')
    }
    /** 会话状态徽标：只认已知状态，其余走中性样式。 */
    function sessionBadgeClass(state) {
      if (state === 'running' || state === 'starting') return 'rn-badge rn-badge-running'
      if (state === 'idle') return 'rn-badge rn-badge-idle'
      if (state === 'offline') return 'rn-badge rn-badge-offline'
      if (state === 'error') return 'rn-badge rn-badge-error'
      return 'rn-badge'
    }
    function syncStateText(syncState, localAvailable) {
      if (localAvailable === true) return t('syncSynced')
      if (syncState === 'fetching') return t('syncFetching')
      if (syncState === 'synced') return t('syncSynced')
      if (syncState === 'error') return t('syncError')
      if (syncState === 'metadata') return t('syncMetadata')
      return t('syncMetadata')
    }
    function syncStateClass(syncState, localAvailable) {
      if (localAvailable === true || syncState === 'synced') return 'rn-deliv-status rn-deliv-status-synced'
      if (syncState === 'fetching') return 'rn-deliv-status rn-deliv-status-fetching'
      if (syncState === 'error') return 'rn-deliv-status rn-deliv-status-error'
      return 'rn-deliv-status'
    }
    function directionText(direction) {
      if (direction === 'out' || direction === 'outbound') return t('directionOut')
      if (direction === 'in' || direction === 'inbound') return t('directionIn')
      return t('emptyValue')
    }
    /** 会话方向文案：outbound = 我发起（运行在对端），inbound = 对端发起。 */
    function sessionDirectionText(direction) {
      if (direction === 'outbound' || direction === 'out') return t('sessionDirectionOut')
      if (direction === 'inbound' || direction === 'in') return t('sessionDirectionIn')
      return t('emptyValue')
    }
    function kindText(kind) {
      if (kind === 'image') return t('kindImage')
      if (kind === 'model') return t('kindModel')
      return t('kindFile')
    }
    function roleLabel(kind, event) {
      if (kind === 'user') return t('roleUser')
      if (kind === 'assistant') return t('roleAssistant')
      if (kind === 'tool-call') return t('roleToolCall')
      if (kind === 'tool-result') return t('roleToolResult')
      if (kind === 'deliverable') return t('roleDeliverable')
      if (kind === 'turn') return t('roleTurn')
      return t('roleEvent')
    }
    /** 判定转录事件的展示类别。 */
    function eventKind(event) {
      const item = isObject(event) ? event : {}
      const type = asText(item.type)
      const role = asText(item.role)
      if (type === 'user/message' || role === 'user') return 'user'
      if (type === 'assistant/message' || role === 'assistant') return 'assistant'
      if (type === 'tool/call') return 'tool-call'
      if (type === 'tool/result') return 'tool-result'
      if (type === 'deliverables/presented') return 'deliverable'
      if (type === 'turn/start' || type === 'turn/end') return 'turn'
      return 'meta'
    }

    // ------------------------------------------------------------
    // 交付物类型图标（currentColor，无硬编码颜色）
    // ------------------------------------------------------------
    function kindIcon(kind) {
      const props = {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        'aria-hidden': true,
        className: 'rn-kind-icon',
      }
      if (kind === 'image') {
        return h('svg', props,
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('circle', { cx: 9, cy: 10, r: 1.6, fill: 'currentColor' }),
          h('path', { d: 'M4 18l5-5 4 4 2-2 5 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }))
      }
      if (kind === 'model') {
        return h('svg', props,
          h('path', { d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M12 12l8-4.5M12 12v9M12 12L4 7.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }))
      }
      return h('svg', props,
        h('path', { d: 'M6 3h8l4 4v14H6V3z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M14 3v4h4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M9 12h6M9 16h6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }))
    }

    // ------------------------------------------------------------
    // Host 接口（对齐 SPEC §7；统一解包 { ok, error }）
    // ------------------------------------------------------------
    function requestJson(path, init) {
      return Promise.resolve().then(function () {
        if (typeof fetch !== 'function') throw new Error('当前环境不支持 fetch，无法访问远程节点接口')
        const options = init && typeof init === 'object' ? init : {}
        const headers = Object.assign({ accept: 'application/json' }, options.headers || {})
        return fetch(API + path, Object.assign({}, options, { headers: headers, cache: 'no-store' }))
      }).then(function (response) {
        if (!response || typeof response.json !== 'function') throw new Error('远程节点接口无响应')
        if (response.ok === false) throw new Error('接口 HTTP ' + String(response.status))
        return response.json().catch(function () { return null })
      }).then(function (body) {
        if (!isObject(body)) throw new Error('远程节点接口返回格式异常')
        if (body.ok !== true) throw new Error(textOr(body.error, '远程节点操作失败'))
        return body
      })
    }
    function apiGet(path) {
      return requestJson(path, { method: 'GET' })
    }
    function apiPost(path, payload) {
      return requestJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
      })
    }
    /** 给「拉取」这类最长 30s 的请求加一个客户端超时，避免按钮永久 busy。 */
    function withTimeout(promise, ms) {
      return new Promise(function (resolve, reject) {
        let settled = false
        const timer = setTimeout(function () {
          if (settled) return
          settled = true
          reject(new Error('请求超时'))
        }, ms)
        promise.then(function (value) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        }, function (error) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        })
      })
    }
    function artifactUrl(key) {
      const text = asText(key)
      if (text === '') return ''
      return API + '/artifact?key=' + encodeURIComponent(text)
    }

    // ------------------------------------------------------------
    // 数据规范化：字段缺失 / 类型错误一律降级为安全默认值
    // ------------------------------------------------------------
    function normalizeSelf(value) {
      if (!isObject(value)) return null
      const listen = isObject(value.listen) ? value.listen : {}
      return {
        nodeId: asText(value.nodeId),
        nodeName: asText(value.nodeName),
        instanceEpoch: asText(value.instanceEpoch),
        protocol: numOrNull(value.protocol),
        dataDir: asText(value.dataDir),
        listen: {
          enabled: listen.enabled === true,
          host: textOr(listen.host, '127.0.0.1'),
          port: numOrNull(listen.port),
        },
        // v1.2：旧 Host 没有这两个字段，按 config 展示，不报错。
        listenSource: value.listenSource === 'settings' || value.listenSource === 'default'
          ? value.listenSource
          : 'config',
        listenOverride: value.listenOverride === true,
      }
    }
    function normalizePeer(value, index) {
      const item = isObject(value) ? value : {}
      const remote = isObject(item.remote) ? item.remote : null
      const id = asText(item.peerNodeId)
      return {
        peerNodeId: id,
        nodeName: asText(item.nodeName),
        state: textOr(item.state, 'offline'),
        direction: item.direction === 'in' || item.direction === 'out' ? item.direction : null,
        linkId: asText(item.linkId),
        lastSeen: numOrNull(item.lastSeen),
        rttMs: numOrNull(item.rttMs),
        remote: remote === null ? null : {
          nodeId: asText(remote.nodeId),
          nodeName: asText(remote.nodeName),
          platform: asText(remote.platform),
        },
        error: item.error === null || item.error === undefined ? '' : asText(item.error),
        source: item.source === 'paired' ? 'paired' : 'config',
        removable: item.removable === true,
        key: id === '' ? 'peer-' + String(index) : id,
      }
    }
    function normalizeSession(value, index) {
      const item = isObject(value) ? value : {}
      const id = textOr(item.id, asText(item.key))
      const peerNodeId = asText(item.peerNodeId)
      return {
        id: id,
        linkId: asText(item.linkId),
        linkSessionId: asText(item.linkSessionId),
        peerNodeId: peerNodeId,
        direction: item.direction === 'outbound' || item.direction === 'inbound' ? item.direction : '',
        state: textOr(item.state, 'idle'),
        title: asText(item.title),
        createdAt: numOrNull(item.createdAt),
        updatedAt: numOrNull(item.updatedAt),
        lastSeq: numOrNull(item.lastSeq),
        error: item.error === null || item.error === undefined ? '' : asText(item.error),
        deliverableCount: numOrNull(item.deliverableCount) === null ? 0 : Math.max(0, Math.round(numOrNull(item.deliverableCount))),
        key: id === '' ? 'session-' + String(index) : id,
      }
    }
    function normalizeDeliverable(value, index) {
      const item = isObject(value) ? value : {}
      const key = asText(item.key)
      return {
        key: key,
        linkId: asText(item.linkId),
        peerNodeId: asText(item.peerNodeId),
        originNodeId: asText(item.originNodeId),
        deliverableId: asText(item.deliverableId),
        sessionId: item.sessionId === null || item.sessionId === undefined ? '' : asText(item.sessionId),
        logicalPath: asText(item.logicalPath),
        name: textOr(item.name, textOr(item.logicalPath, key)),
        kind: textOr(item.kind, 'file'),
        bytes: numOrNull(item.bytes),
        sha256: asText(item.sha256),
        version: numOrNull(item.version),
        syncState: textOr(item.syncState, 'metadata'),
        localAvailable: item.localAvailable === true,
        error: item.error === null || item.error === undefined ? '' : asText(item.error),
        createdAt: numOrNull(item.createdAt),
        updatedAt: numOrNull(item.updatedAt),
        rowKey: key === '' ? 'deliverable-' + String(index) : key,
      }
    }
    /** 本机配对令牌（v1.1 §10.3；Host 未提供时为 null，面板隐藏该区块）。 */
    function normalizePairing(value) {
      if (!isObject(value)) return null
      return {
        token: asText(value.token),
        fingerprint: asText(value.fingerprint),
        createdAt: numOrNull(value.createdAt),
        fixedByConfig: value.fixedByConfig === true,
      }
    }
    /** 一条待审批的配对请求（v1.1 §10.3）。 */
    function normalizePendingPair(value, index) {
      const item = isObject(value) ? value : {}
      const requestId = asText(item.requestId)
      return {
        requestId: requestId,
        nodeId: asText(item.nodeId),
        nodeName: asText(item.nodeName),
        remoteAddress: asText(item.remoteAddress),
        remotePort: numOrNull(item.remotePort),
        listenPort: numOrNull(item.listenPort),
        createdAt: numOrNull(item.createdAt),
        key: requestId === '' ? 'pair-' + String(index) : requestId,
      }
    }
    function normalizeSnapshot(body) {
      const source = isObject(body) ? body : {}
      return {
        self: normalizeSelf(source.self),
        peers: asArray(source.peers).map(normalizePeer),
        sessions: asArray(source.sessions).map(normalizeSession),
        deliverables: asArray(source.deliverables).map(normalizeDeliverable),
        pairing: normalizePairing(source.pairing),
        pendingPairs: asArray(source.pendingPairs).map(normalizePendingPair),
        warnings: asArray(source.warnings).map(function (item) {
          return asText(item)
        }).filter(function (text) {
          return text !== ''
        }),
      }
    }
    function fetchState() {
      return apiGet('/state').then(normalizeSnapshot)
    }
    function fetchTranscript(sessionId) {
      return apiGet('/session/transcript?sessionId=' + encodeURIComponent(asText(sessionId))).then(function (body) {
        return {
          session: isObject(body.session) ? normalizeSession(body.session, 0) : null,
          events: asArray(body.events),
        }
      })
    }

    // ------------------------------------------------------------
    // 轮询：状态每 2s；页面隐藏时跳过本轮（只影响界面，不影响 Host）
    // ------------------------------------------------------------
    function useSnapshotPolling() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [updatedAt, setUpdatedAt] = useState(0)
      const [nonce, setNonce] = useState(0)
      const reload = useCallback(function () {
        setNonce(function (value) { return value + 1 })
      }, [])
      useEffect(function () {
        let alive = true
        let timer = null
        function schedule() {
          if (!alive) return
          timer = setTimeout(load, POLL_MS)
        }
        function load() {
          if (!alive) return
          timer = null
          try {
            if (typeof document !== 'undefined' && document && document.hidden === true) {
              schedule()
              return
            }
          } catch (ignore) {
            // document 访问异常时照常请求。
          }
          fetchState().then(function (next) {
            if (!alive) return
            setData(next)
            setError('')
            setUpdatedAt(Date.now())
            schedule()
          }).catch(function (failure) {
            if (!alive) return
            setError(errText(failure))
            schedule()
          })
        }
        load()
        return function () {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [nonce])
      return { data: data, error: error, updatedAt: updatedAt, reload: reload }
    }

    /** 会话详情转录轮询（2s）；sessionId 为空时什么也不做。 */
    function useTranscript(sessionId) {
      const [state, setState] = useState(function () {
        return { session: null, events: [], error: '', loading: true }
      })
      const [nonce, setNonce] = useState(0)
      const reload = useCallback(function () {
        setNonce(function (value) { return value + 1 })
      }, [])
      useEffect(function () {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setState({ session: null, events: [], error: '', loading: false })
          return undefined
        }
        let alive = true
        let timer = null
        function schedule() {
          if (!alive) return
          timer = setTimeout(load, POLL_MS)
        }
        function load() {
          if (!alive) return
          timer = null
          try {
            if (typeof document !== 'undefined' && document && document.hidden === true) {
              schedule()
              return
            }
          } catch (ignore) {
            // 继续请求。
          }
          fetchTranscript(sessionId).then(function (next) {
            if (!alive) return
            setState({ session: next.session, events: next.events, error: '', loading: false })
            schedule()
          }).catch(function (failure) {
            if (!alive) return
            setState(function (previous) {
              return {
                session: previous.session,
                events: previous.events,
                error: errText(failure),
                loading: false,
              }
            })
            schedule()
          })
        }
        load()
        return function () {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [sessionId, nonce])
      return {
        session: state.session,
        events: state.events,
        error: state.error,
        loading: state.loading,
        reload: reload,
      }
    }

    // ------------------------------------------------------------
    // 样式：只引用宿主主题 token，不写死颜色；类名前缀 rn-
    // ------------------------------------------------------------
    const CSS = `
.rn-root { display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; height: 100%; min-height: 0; padding: 24px clamp(20px, 3vw, 34px) 28px; color: var(--dsw-alias-label-primary); overflow: hidden; font-size: 13px; line-height: 1.5; }
.rn-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding-right: 4px; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent; }
.rn-header { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.rn-header-text { min-width: 0; }
.rn-title { margin: 0; font-size: 17px; line-height: 24px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rn-sub { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.rn-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rn-btn { appearance: none; font: inherit; font-size: 12px; line-height: 1.5; padding: 4px 11px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; box-sizing: border-box; }
.rn-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.rn-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.rn-btn:disabled { opacity: .55; cursor: default; }
.rn-btn-primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); }
.rn-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); opacity: .9; }
.rn-btn-active { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.rn-alert { flex: none; display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.rn-alert-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.rn-alert-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.rn-alert-close { margin-left: auto; appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 0 2px; flex: none; }
.rn-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.rn-section-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rn-section-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.rn-section-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.rn-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.rn-card { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); min-width: 0; box-sizing: border-box; }
.rn-link-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rn-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.rn-dot-online { background: var(--dsw-alias-state-success-primary); }
.rn-dot-offline { background: var(--dsw-alias-state-idle-primary); }
.rn-dot-dialing { background: var(--dsw-alias-state-warn-primary); }
.rn-dot-error { background: var(--dsw-alias-state-error-primary); }
.rn-link-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.rn-link-state { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.rn-kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 2px 14px; }
.rn-kv { display: flex; align-items: baseline; gap: 8px; justify-content: space-between; font-size: 11.5px; min-width: 0; }
.rn-k { color: var(--dsw-alias-label-tertiary); white-space: nowrap; flex: none; }
.rn-v { color: var(--dsw-alias-label-secondary); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-variant-numeric: tabular-nums; }
.rn-card-error { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.rn-card-foot { font-size: 10.5px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }
.rn-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-sizing: border-box; }
.rn-col-head { display: flex; align-items: baseline; gap: 8px; }
.rn-col-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.rn-count { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.rn-rows { display: flex; flex-direction: column; gap: 6px; }
.rn-session { appearance: none; font: inherit; display: flex; align-items: center; gap: 10px; text-align: left; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; min-width: 0; box-sizing: border-box; }
.rn-session:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.rn-session:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.rn-session:disabled { cursor: default; opacity: .85; }
.rn-session-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.rn-session-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-session-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rn-badge { flex: none; font-size: 11px; line-height: 1.5; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.rn-badge-running { color: var(--dsw-alias-state-business-primary); }
.rn-badge-idle { color: var(--dsw-alias-state-success-primary); }
.rn-badge-offline { color: var(--dsw-alias-state-idle-primary); }
.rn-badge-error { color: var(--dsw-alias-state-error-primary); }
.rn-empty { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); padding: 8px 2px; overflow-wrap: anywhere; }
.rn-empty-hint { font-size: 11px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); overflow-wrap: anywhere; }
.rn-form { display: flex; flex-direction: column; gap: 9px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); box-sizing: border-box; }
.rn-form-head { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rn-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rn-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rn-input, .rn-textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px 9px; }
.rn-input:focus, .rn-textarea:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.rn-textarea { resize: vertical; min-height: 64px; }
.rn-form-actions, .rn-composer-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.rn-deliv-group { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.rn-deliv-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rn-deliv-peer { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.rn-deliv-link { font-size: 10.5px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-deliv { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); min-width: 0; box-sizing: border-box; }
.rn-kind-icon { flex: none; color: var(--dsw-alias-label-tertiary); }
.rn-deliv-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.rn-deliv-name { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-deliv-meta { display: flex; gap: 4px 10px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.rn-deliv-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.rn-deliv-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.rn-thumb { display: inline-flex; width: 44px; height: 44px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); align-items: center; justify-content: center; flex: none; }
.rn-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rn-thumb-empty { width: 44px; height: 44px; border-radius: 8px; border: 1px dashed var(--dsw-alias-border-l2); display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary); font-size: 10px; flex: none; box-sizing: border-box; }
.rn-detail { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.rn-detail-header { align-items: center; }
.rn-detail-head-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 auto; }
.rn-deliv-groups { gap: 12px; }
.rn-detail-title { font-size: 15px; line-height: 22px; }
.rn-transcript { flex: 1 1 auto; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-sizing: border-box; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent; }
.rn-event { display: flex; flex-direction: column; gap: 4px; padding: 7px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); min-width: 0; box-sizing: border-box; }
.rn-event-user { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); }
.rn-event-assistant { background: var(--dsw-alias-bg-layer-1); }
.rn-event-deliverable { border-color: var(--dsw-alias-state-business-primary); }
.rn-event-turn { background: transparent; border-style: dashed; }
.rn-event-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rn-event-role { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.rn-event-role-user { color: var(--dsw-alias-brand-primary); }
.rn-event-role-tool-call, .rn-event-role-tool-result { color: var(--dsw-alias-state-warn-primary); }
.rn-event-role-deliverable { color: var(--dsw-alias-state-business-primary); }
.rn-event-meta { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rn-event-text { font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.rn-event-tool { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.rn-event-tool-name { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.rn-event-tool-error .rn-event-tool-name { color: var(--dsw-alias-state-error-primary); }
.rn-event-pre { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 6px 8px; max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.rn-event-files { display: flex; flex-direction: column; gap: 4px; }
.rn-event-file { display: flex; flex-direction: column; gap: 1px; font-size: 11.5px; min-width: 0; }
.rn-event-file-path { color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.rn-event-file-desc { color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.rn-event-turn-line, .rn-event-meta-line { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.rn-composer { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-sizing: border-box; }
.rn-prompt { min-height: 60px; max-height: 180px; resize: vertical; }
.rn-composer-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rn-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); margin-right: auto; }
.rn-center { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; }
.rn-btn-sm { font-size: 11px; line-height: 1.5; padding: 2px 8px; border-radius: 6px; }
.rn-pairing { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); box-sizing: border-box; }
.rn-pairing-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.rn-token { flex: 1 1 240px; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.5; letter-spacing: .5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 4px 8px; overflow-wrap: anywhere; user-select: all; }
.rn-token-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: none; }
.rn-pairing-fp { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.rn-pairing-hint { flex-basis: 100%; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.rn-pair-requests { display: flex; flex-direction: column; gap: 8px; }
.rn-pair-card { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 12px; border: 1px solid var(--dsw-alias-state-business-primary); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); box-sizing: border-box; }
.rn-pair-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 240px; }
.rn-pair-name { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-pair-meta { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.rn-pair-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: none; }
.rn-source-tag { font-size: 10.5px; line-height: 1.5; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.rn-source-tag-paired { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.rn-link-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.rn-remove-confirm { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.rn-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.rn-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.rn-modal-backdrop { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsw-alias-bg-mask-1); }
.rn-modal { display: flex; flex-direction: column; gap: 10px; width: min(480px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; padding: 16px 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 12px 40px var(--dsw-alias-bg-mask-drop); box-sizing: border-box; }
.rn-modal-title { font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rn-modal-hint { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.rn-modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.rn-token-input { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .5px; }
.rn-listen-value { flex: 0 1 auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 3px 8px; white-space: nowrap; }
.rn-listen-off { color: var(--dsw-alias-label-tertiary); }
.rn-check-row { flex-direction: row; align-items: center; gap: 8px; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
.rn-check-row input[type="checkbox"] { margin: 0; flex: none; }
.rn-field-hint { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
`

    /** 唯一的样式注入点：一个 React <style> 元素（不碰 document.head/body）。 */
    function StyleTag() {
      return h('style', {
        key: 'rn-styles',
        dangerouslySetInnerHTML: { __html: CSS },
      })
    }

    // ------------------------------------------------------------
    // 纯渲染片段（在父组件 try/catch 内调用，全部容错）
    // ------------------------------------------------------------
    function renderSelfLine(self) {
      if (!self) return t('loadingState')
      const parts = []
      let name = self.nodeName !== '' ? self.nodeName : self.nodeId
      if (name === '') name = t('unknownPeer')
      const idPart = self.nodeId !== '' ? ' · ' + self.nodeId : ''
      parts.push(t('self') + ' ' + name + idPart)
      if (self.listen && self.listen.enabled === true) {
        const port = self.listen.port === null ? '?' : String(self.listen.port)
        parts.push(t('listen') + ' ' + self.listen.host + ':' + port)
      } else {
        parts.push(t('listen') + ' ' + t('notListening'))
      }
      return parts.join(' · ')
    }

    function fmtUpdatedLine(updatedAt) {
      const num = numOrNull(updatedAt)
      if (num === null || num <= 0) return ''
      return t('updatedAt') + ' ' + fmtClock(num)
    }

    /** 令牌掩码：默认不渲染任何真实字符。 */
    function maskedToken() {
      return '••••••••••••••••'
    }
    /** 节点来源标签文案。 */
    function peerSourceText(peer) {
      return peer && peer.source === 'paired' ? t('sourcePaired') : t('sourceConfig')
    }

    /** 是否 loopback（决定弹窗内是否提示对外暴露风险）。 */
    function isLoopbackHost(host) {
      const text = asText(host).trim().toLowerCase()
      if (text === '') return true
      if (text === 'localhost' || text === '::1' || text === '[::1]') return true
      if (text === '127.0.0.1') return true
      if (text.indexOf('127.') === 0) return true
      return false
    }
    /** 监听来源文案（v1.2 §11.4）。 */
    function listenSourceText(source) {
      if (source === 'settings') return t('listenSourceSettings')
      if (source === 'default') return t('listenSourceDefault')
      return t('listenSourceConfig')
    }
    /** 监听值展示文本，如 127.0.0.1:47201 / 已关闭。 */
    function listenText(listen) {
      const item = isObject(listen) ? listen : {}
      if (item.enabled !== true) return t('listenDisabled')
      const host = asText(item.host)
      const port = numOrNull(item.port)
      return (host === '' ? '?' : host) + ':' + (port === null ? '?' : String(port))
    }

    /**
     * 「监听」卡片（v1.2 §11.4）：显示有效 enabled/host:port 与来源，
     * 提供「修改」；存在面板覆盖（listenOverride）时提供「恢复配置文件设置」。
     * self 为 null（初始加载/旧 Host）时隐藏。
     */
    function renderListenCard(self, opts) {
      if (!self) return null
      const listen = isObject(self.listen) ? self.listen : { enabled: false, host: '', port: null }
      const source = listenSourceText(self.listenSource)
      const enabled = listen.enabled === true
      const children = [
        h('span', { key: 'label', className: 'rn-pairing-label' }, t('listenTitle')),
        h('span', { key: 'value', className: 'rn-listen-value' + (enabled ? '' : ' rn-listen-off') }, listenText(listen)),
        h('span', {
          key: 'source',
          className: 'rn-source-tag' + (self.listenSource === 'settings' ? ' rn-source-tag-paired' : ''),
          title: t('listenSourcePrefix') + ' ' + source,
        }, t('listenSourcePrefix') + ' ' + source),
        h('div', { key: 'actions', className: 'rn-token-actions' },
          h('button', {
            type: 'button',
            className: 'rn-btn rn-btn-sm',
            onClick: opts.onEdit,
          }, t('listenEdit')),
          self.listenOverride === true
            ? h('button', {
              key: 'reset',
              type: 'button',
              className: 'rn-btn rn-btn-sm',
              disabled: opts.busy === 'listen-reset',
              onClick: opts.onReset,
            }, opts.busy === 'listen-reset' ? t('listenSaving') : t('listenReset'))
            : null),
        h('span', { key: 'hint', className: 'rn-pairing-hint' }, t('listenHint')),
      ]
      return h('section', { className: 'rn-section', key: 'listen' },
        h('div', { className: 'rn-pairing' }, children))
    }

    /** 「修改监听设置」弹窗（v1.2 §11.4）：启用开关 + 绑定地址 + 端口 + 校验/安全提示/后端错误。 */
    function renderListenModal(opts) {
      const saving = opts.saving === true
      const external = isLoopbackHost(opts.host) === false
      const children = [
        h('div', { key: 'title', className: 'rn-modal-title' }, t('listenEditTitle')),
        h('div', { key: 'hint', className: 'rn-modal-hint' }, t('listenEditHint')),
        h('label', { key: 'enabled', className: 'rn-field rn-check-row' },
          h('input', {
            type: 'checkbox',
            checked: opts.enabled === true,
            onChange: opts.onEnabledChange,
          }),
          h('span', null, t('listenEnabledLabel'))),
        h('label', { key: 'host', className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('listenHostLabel')),
          h('input', {
            className: 'rn-input',
            type: 'text',
            value: opts.host,
            placeholder: t('listenHostPlaceholder'),
            onChange: opts.onHostChange,
          }),
          h('span', { className: 'rn-field-hint' }, t('listenHostHint'))),
        h('label', { key: 'port', className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('listenPortLabel')),
          h('input', {
            className: 'rn-input',
            type: 'text',
            inputMode: 'numeric',
            value: opts.port,
            placeholder: t('listenPortPlaceholder'),
            onChange: opts.onPortChange,
          })),
      ]
      if (external) {
        children.push(h('div', { key: 'external', className: 'rn-alert rn-alert-warn', role: 'status' },
          h('span', null, t('listenExternalWarning'))))
      }
      if (opts.error !== '') {
        children.push(h('div', { key: 'error', className: 'rn-alert', role: 'alert' },
          h('span', null, opts.error)))
      }
      children.push(h('div', { key: 'actions', className: 'rn-modal-actions' },
        h('button', { key: 'cancel', type: 'button', className: 'rn-btn', disabled: saving, onClick: opts.onClose }, t('cancel')),
        h('button', {
          key: 'save',
          type: 'button',
          className: 'rn-btn rn-btn-primary',
          disabled: saving,
          onClick: opts.onSave,
        }, saving ? t('listenSaving') : t('listenSave'))))
      return h('div', {
        className: 'rn-modal-backdrop',
        key: 'listen-modal',
        onMouseDown: function (event) {
          if (!event) return
          if (event.target === event.currentTarget && !saving) opts.onClose()
        },
      },
      h('div', { className: 'rn-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('listenEditTitle') }, children))
    }

    /**
     * 配对令牌条（v1.1 §10.5）：默认掩码，可显示/复制；未由 config 固定时可轮换。
     * pairing 为 null（Host 未提供该字段）时整块隐藏，保持对旧 Host 的兼容。
     */
    function renderPairingBar(pairing, opts) {
      if (!pairing) return null
      const token = pairing.token
      const visible = opts.visible === true && token !== ''
      const rotating = opts.busy === 'rotate'
      const children = [
        h('span', { key: 'label', className: 'rn-pairing-label' }, t('pairingTitle')),
        h('span', {
          key: 'token',
          className: 'rn-token',
          title: visible ? token : t('pairingHint'),
        }, visible ? token : maskedToken()),
      ]
      if (pairing.fingerprint !== '') {
        children.push(h('span', { key: 'fp', className: 'rn-pairing-fp', title: pairing.fingerprint },
          t('fingerprint') + ' ' + shortId(pairing.fingerprint, 32)))
      }
      children.push(h('div', { key: 'actions', className: 'rn-token-actions' },
        h('button', {
          type: 'button',
          className: 'rn-btn rn-btn-sm',
          disabled: token === '',
          onClick: opts.onToggle,
        }, visible ? t('hideToken') : t('showToken')),
        h('button', {
          type: 'button',
          className: 'rn-btn rn-btn-sm',
          disabled: token === '',
          onClick: opts.onCopy,
        }, t('copyToken')),
        h('button', {
          type: 'button',
          className: 'rn-btn rn-btn-sm',
          disabled: pairing.fixedByConfig || rotating,
          title: pairing.fixedByConfig ? t('fixedByConfig') : '',
          onClick: opts.onRotate,
        }, rotating ? t('rotating') : t('rotateToken'))))
      children.push(h('span', { key: 'hint', className: 'rn-pairing-hint' },
        pairing.fixedByConfig ? t('fixedByConfig') : t('pairingHint')))
      return h('section', { className: 'rn-section', key: 'pairing' },
        h('div', { className: 'rn-pairing' }, children))
    }

    /** 待审批的配对请求卡片（v1.1 §10.5）：仅 pendingPairs 非空时显示。 */
    function renderPendingPairsSection(pairs, opts) {
      if (!Array.isArray(pairs) || pairs.length === 0) return null
      return h('section', { className: 'rn-section', key: 'pending-pairs' },
        h('div', { className: 'rn-section-head' },
          h('h3', { className: 'rn-section-title' }, t('pendingPairs')),
          h('span', { className: 'rn-section-meta' }, String(pairs.length))),
        h('div', { className: 'rn-pair-requests' }, pairs.map(function (pair) {
          const approving = opts.busy === 'approve:' + pair.requestId
          const rejecting = opts.busy === 'reject:' + pair.requestId
          const disabled = pair.requestId === '' || approving || rejecting
          const address = pair.remoteAddress !== ''
            ? pair.remoteAddress + (pair.remotePort === null ? '' : ':' + String(pair.remotePort))
            : t('emptyValue')
          const meta = [t('pendingFrom') + ' ' + address]
          if (pair.listenPort !== null) meta.push(t('listenPortLabel') + ' ' + String(pair.listenPort))
          if (pair.createdAt !== null && pair.createdAt > 0) meta.push(fmtAgo(pair.createdAt))
          return h('div', { className: 'rn-pair-card', key: pair.key },
            h('div', { className: 'rn-pair-main' },
              h('div', { className: 'rn-pair-name', title: pair.nodeId },
                textOr(pair.nodeName, textOr(pair.nodeId, t('unknownPeer')))),
              h('div', { className: 'rn-pair-meta' }, meta.join(' · '))),
            h('div', { className: 'rn-pair-actions' },
              h('button', {
                type: 'button',
                className: 'rn-btn rn-btn-sm rn-btn-primary',
                disabled: disabled,
                onClick: function () { opts.onApprove(pair) },
              }, approving ? t('approving') : t('approve')),
              h('button', {
                type: 'button',
                className: 'rn-btn rn-btn-sm',
                disabled: disabled,
                onClick: function () { opts.onReject(pair) },
              }, rejecting ? t('rejecting') : t('reject'))))
        })),
        h('div', { className: 'rn-empty-hint' }, t('pendingPairsHint')))
    }

    /** 「添加节点」弹窗（v1.1 §10.5）：地址/端口/令牌/可选名称。 */
    function renderAddNodeModal(opts) {
      const pairingNow = opts.busy === 'pair'
      return h('div', {
        className: 'rn-modal-backdrop',
        key: 'add-node-modal',
        onMouseDown: function (event) {
          if (!event) return
          if (event.target === event.currentTarget) opts.onClose()
        },
      },
      h('div', { className: 'rn-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('addNodeTitle') },
        h('div', { className: 'rn-modal-title' }, t('addNodeTitle')),
        h('div', { className: 'rn-modal-hint' }, t('addNodeHint')),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('nodeNameOptional')),
          h('input', {
            className: 'rn-input',
            type: 'text',
            value: opts.name,
            placeholder: t('nodeNamePlaceholder'),
            onChange: opts.onNameChange,
          })),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('nodeAddress')),
          h('input', {
            className: 'rn-input',
            type: 'text',
            value: opts.host,
            placeholder: t('nodeAddressPlaceholder'),
            onChange: opts.onHostChange,
          })),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('nodePort')),
          h('input', {
            className: 'rn-input',
            type: 'text',
            inputMode: 'numeric',
            value: opts.port,
            placeholder: t('nodePortPlaceholder'),
            onChange: opts.onPortChange,
          })),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('nodeToken')),
          h('input', {
            className: 'rn-input rn-token-input',
            type: 'text',
            value: opts.token,
            placeholder: t('nodeTokenPlaceholder'),
            onChange: opts.onTokenChange,
            spellCheck: false,
            autoComplete: 'off',
          })),
        h('div', { className: 'rn-modal-actions' },
          h('button', { type: 'button', className: 'rn-btn', onClick: opts.onClose }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'rn-btn rn-btn-primary',
            disabled: pairingNow,
            onClick: opts.onSubmit,
          }, pairingNow ? t('pairing') : t('startPairing')))))
    }

    function renderLinkCard(peer, opts) {
      const rows = []
      rows.push(h('span', { key: 'id', className: 'rn-kv' },
        h('span', { className: 'rn-k' }, 'ID'),
        h('span', { className: 'rn-v', title: peer.peerNodeId }, peer.peerNodeId === '' ? t('emptyValue') : peer.peerNodeId)))
      rows.push(h('span', { key: 'dir', className: 'rn-kv' },
        h('span', { className: 'rn-k' }, t('direction')),
        h('span', { className: 'rn-v' }, directionText(peer.direction))))
      rows.push(h('span', { key: 'rtt', className: 'rn-kv' },
        h('span', { className: 'rn-k' }, t('rtt')),
        h('span', { className: 'rn-v' }, peer.rttMs === null ? t('emptyValue') : Math.round(peer.rttMs) + ' ms')))
      rows.push(h('span', { key: 'seen', className: 'rn-kv' },
        h('span', { className: 'rn-k' }, t('lastSeen')),
        h('span', { className: 'rn-v' }, fmtAgo(peer.lastSeen))))
      if (peer.remote && peer.remote.platform !== '') {
        rows.push(h('span', { key: 'platform', className: 'rn-kv' },
          h('span', { className: 'rn-k' }, 'Platform'),
          h('span', { className: 'rn-v' }, peer.remote.platform)))
      }
      const actions = [
        h('span', {
          key: 'source',
          className: 'rn-source-tag' + (peer.source === 'paired' ? ' rn-source-tag-paired' : ''),
        }, peerSourceText(peer)),
      ]
      const confirmRemove = opts && opts.confirmRemove === peer.peerNodeId && peer.peerNodeId !== ''
      if (peer.removable) {
        if (confirmRemove) {
          const removing = opts.busy === 'remove:' + peer.peerNodeId
          actions.push(h('span', { key: 'confirm', className: 'rn-remove-confirm' },
            h('span', null, t('removeConfirm')),
            h('button', {
              type: 'button',
              className: 'rn-btn rn-btn-sm rn-btn-danger',
              disabled: removing,
              title: t('removeConfirmHint'),
              onClick: function () { opts.onConfirmRemove(peer) },
            }, removing ? t('removing') : t('confirmRemove')),
            h('button', {
              type: 'button',
              className: 'rn-btn rn-btn-sm',
              disabled: removing,
              onClick: opts.onCancelRemove,
            }, t('cancel'))))
        } else {
          actions.push(h('button', {
            key: 'remove',
            type: 'button',
            className: 'rn-btn rn-btn-sm rn-btn-danger',
            disabled: opts.busy === 'remove:' + peer.peerNodeId,
            title: t('removeConfirmHint'),
            onClick: function () { opts.onAskRemove(peer) },
          }, t('removeNode')))
        }
      }
      return h('div', { className: 'rn-card', key: peer.key },
        h('div', { className: 'rn-link-head' },
          h('span', { className: peerDotClass(peer.state), title: peerStateText(peer.state) }),
          h('span', { className: 'rn-link-name', title: peer.nodeName || peer.peerNodeId },
            textOr(peer.nodeName, textOr(peer.peerNodeId, t('unknownPeer')))),
          h('span', { className: 'rn-link-state' }, peerStateText(peer.state))),
        h('div', { className: 'rn-kv-grid' }, rows),
        peer.error !== '' ? h('div', { className: 'rn-card-error' }, peer.error) : null,
        peer.linkId !== '' ? h('div', { className: 'rn-card-foot', title: peer.linkId }, peer.linkId) : null,
        h('div', { className: 'rn-link-actions' }, actions))
    }

    function renderLinksSection(peers, opts) {
      const body = peers.length === 0
        ? h('div', { className: 'rn-empty' },
          h('div', null, t('noPeers')),
          h('div', { className: 'rn-empty-hint' }, t('noPeersHint')))
        : h('div', { className: 'rn-cards' }, peers.map(function (peer) {
          return renderLinkCard(peer, opts)
        }))
      return h('section', { className: 'rn-section', key: 'links' },
        h('div', { className: 'rn-section-head' },
          h('h3', { className: 'rn-section-title' }, t('links')),
          h('span', { className: 'rn-section-meta' }, String(peers.length))),
        body)
    }

    function renderSessionRow(session, onOpen) {
      const clickable = session.id !== ''
      const title = session.title !== ''
        ? session.title
        : (session.linkSessionId !== '' ? shortId(session.linkSessionId, 46) : t('untitledSession'))
      const metaParts = []
      metaParts.push(session.peerNodeId !== '' ? session.peerNodeId : t('unknownPeer'))
      if (session.updatedAt !== null && session.updatedAt > 0) metaParts.push(fmtAgo(session.updatedAt))
      if (session.deliverableCount > 0) metaParts.push(t('deliverableCountLabel') + ' ' + String(session.deliverableCount))
      const children = [
        h('span', { key: 'main', className: 'rn-session-main' },
          h('span', { className: 'rn-session-title', title: title }, title),
          h('span', { className: 'rn-session-meta', title: session.linkSessionId !== '' ? session.linkSessionId : '' },
            metaParts.join(' · '))),
        h('span', { key: 'badge', className: sessionBadgeClass(session.state) }, sessionStateText(session.state)),
      ]
      return h('button', {
        key: session.key,
        type: 'button',
        className: 'rn-session',
        disabled: !clickable,
        title: session.linkSessionId !== '' ? session.linkSessionId : '',
        onClick: clickable ? function () { onOpen(session.id) } : undefined,
      }, children)
    }

    function renderSessionColumn(title, sessions, emptyText, onOpen) {
      return h('div', { className: 'rn-col' },
        h('div', { className: 'rn-col-head' },
          h('span', { className: 'rn-col-title' }, title),
          h('span', { className: 'rn-count' }, String(sessions.length))),
        sessions.length === 0
          ? h('div', { className: 'rn-empty' }, emptyText)
          : h('div', { className: 'rn-rows' }, sessions.map(function (session) {
            return renderSessionRow(session, onOpen)
          })))
    }

    function sortSessions(list) {
      return list.slice().sort(function (left, right) {
        const a = left.updatedAt === null ? 0 : left.updatedAt
        const b = right.updatedAt === null ? 0 : right.updatedAt
        return b - a
      })
    }

    function renderSessionsSection(sessions, onOpen) {
      const inbound = sortSessions(sessions.filter(function (session) { return session.direction === 'inbound' }))
      const outbound = sortSessions(sessions.filter(function (session) { return session.direction !== 'inbound' }))
      return h('section', { className: 'rn-section', key: 'sessions' },
        h('div', { className: 'rn-section-head' },
          h('h3', { className: 'rn-section-title' }, t('sessions')),
          h('span', { className: 'rn-section-meta' }, String(sessions.length))),
        h('div', { className: 'rn-cols' },
          renderSessionColumn(t('outboundGroup'), outbound, t('noOutbound'), onOpen),
          renderSessionColumn(t('inboundGroup'), inbound, t('noInbound'), onOpen)))
    }

    function groupDeliverables(deliverables) {
      const groups = []
      const index = {}
      for (const item of deliverables) {
        const groupKey = item.linkId !== '' ? item.linkId : (item.peerNodeId !== '' ? 'peer:' + item.peerNodeId : 'unknown')
        let group = index[groupKey]
        if (!group) {
          group = { key: groupKey, linkId: item.linkId, peerNodeId: item.peerNodeId, items: [] }
          index[groupKey] = group
          groups.push(group)
        }
        if (group.peerNodeId === '' && item.peerNodeId !== '') group.peerNodeId = item.peerNodeId
        if (group.linkId === '' && item.linkId !== '') group.linkId = item.linkId
        group.items.push(item)
      }
      return groups
    }

    function renderDeliverableRow(item, busyKey, onFetch) {
      const synced = item.localAvailable === true || item.syncState === 'synced'
      const url = artifactUrl(item.key)
      const canFetch = !synced && item.key !== ''
      const fetching = busyKey !== '' && busyKey === 'artifact:' + item.key

      const meta = []
      meta.push(kindText(item.kind))
      meta.push(fmtBytes(item.bytes))
      if (item.version !== null) meta.push(t('version') + ' ' + String(item.version))
      if (item.originNodeId !== '') meta.push(t('origin') + ' ' + item.originNodeId)

      const actions = []
      if (item.kind === 'image' && synced && url !== '') {
        actions.push(h('a', {
          key: 'thumb',
          className: 'rn-thumb',
          href: url,
          target: '_blank',
          rel: 'noreferrer',
          title: t('preview') + ' ' + item.name,
        }, h('img', {
          src: url,
          alt: item.name,
          loading: 'lazy',
          onError: function (event) {
            try {
              if (event && event.currentTarget) event.currentTarget.style.display = 'none'
            } catch (error) {
              // 缩略图加载失败只影响外观。
            }
          },
        })))
      } else if (item.kind === 'image') {
        actions.push(h('span', { key: 'thumb-empty', className: 'rn-thumb-empty', title: syncStateText(item.syncState, false) }, t('kindImage')))
      }
      if (canFetch) {
        actions.push(h('button', {
          key: 'fetch',
          type: 'button',
          className: 'rn-btn',
          disabled: fetching,
          onClick: function () { onFetch(item) },
        }, fetching ? t('fetching') : t('fetch')))
      }
      if (synced && url !== '') {
        actions.push(h('a', {
          key: 'download',
          className: 'rn-btn',
          href: url,
          title: item.name,
        }, t('download')))
      }

      return h('div', { className: 'rn-deliv', key: item.rowKey },
        kindIcon(item.kind),
        h('div', { className: 'rn-deliv-main' },
          h('div', { className: 'rn-deliv-name', title: item.logicalPath || item.name }, item.name),
          h('div', { className: 'rn-deliv-meta' },
            meta.map(function (part, index) {
              return h('span', { key: 'm' + String(index) }, part)
            }),
            h('span', { key: 'sync', className: syncStateClass(item.syncState, item.localAvailable) },
              syncStateText(item.syncState, item.localAvailable))),
          item.error !== '' ? h('div', { className: 'rn-deliv-error' }, item.error) : null),
        h('div', { className: 'rn-deliv-actions' }, actions))
    }

    function renderDeliverablesSection(deliverables, busyKey, onFetch) {
      const groups = groupDeliverables(deliverables)
      const body = deliverables.length === 0
        ? h('div', { className: 'rn-empty' }, t('noDeliverables'))
        : h('div', { className: 'rn-section rn-deliv-groups' }, groups.map(function (group) {
          const label = group.peerNodeId !== '' ? group.peerNodeId : t('unknownPeer')
          return h('div', { className: 'rn-deliv-group', key: group.key },
            h('div', { className: 'rn-deliv-head' },
              h('span', { className: 'rn-deliv-peer' }, label),
              group.linkId !== '' ? h('span', { className: 'rn-deliv-link', title: group.linkId }, group.linkId) : null,
              h('span', { className: 'rn-section-meta' }, String(group.items.length))),
            h('div', { className: 'rn-rows' }, group.items.map(function (item) {
              return renderDeliverableRow(item, busyKey, onFetch)
            })))
        }))
      return h('section', { className: 'rn-section', key: 'deliverables' },
        h('div', { className: 'rn-section-head' },
          h('h3', { className: 'rn-section-title' }, t('deliverables')),
          h('span', { className: 'rn-section-meta' }, String(deliverables.length))),
        body)
    }

    function renderPeerOptions(peers) {
      return peers.map(function (peer, index) {
        const id = peer.peerNodeId
        const label = textOr(peer.nodeName, textOr(id, t('unknownPeer'))) + '（' + peerStateText(peer.state) + '）'
        return h('option', { key: id === '' ? 'peer-' + String(index) : id, value: id }, label)
      })
    }

    function renderStartForm(props) {
      const peers = props.peers
      if (peers.length === 0) {
        return h('div', { className: 'rn-form', key: props.key },
          h('div', { className: 'rn-form-head' }, t('newSession')),
          h('div', { className: 'rn-empty' }, t('noPeerForAction')),
          h('div', { className: 'rn-form-actions' },
            h('button', { type: 'button', className: 'rn-btn', onClick: props.onCancel }, t('cancel'))))
      }
      return h('div', { className: 'rn-form', key: props.key },
        h('div', { className: 'rn-form-head' }, t('newSession')),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('peer')),
          h('select', { className: 'rn-input', value: props.peerValue, onChange: props.onPeerChange },
            renderPeerOptions(peers))),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('initialPrompt')),
          h('textarea', {
            className: 'rn-textarea',
            rows: 3,
            value: props.prompt,
            placeholder: t('initialPromptPlaceholder'),
            onChange: props.onPromptChange,
          })),
        h('div', { className: 'rn-form-actions' },
          h('button', { type: 'button', className: 'rn-btn', onClick: props.onCancel }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'rn-btn rn-btn-primary',
            disabled: props.busy,
            onClick: props.onStart,
          }, props.busy ? t('starting') : t('start'))))
    }

    function renderPublishForm(props) {
      const peers = props.peers
      if (peers.length === 0) {
        return h('div', { className: 'rn-form', key: props.key },
          h('div', { className: 'rn-form-head' }, t('publishTitle')),
          h('div', { className: 'rn-empty' }, t('noPeerForAction')),
          h('div', { className: 'rn-form-actions' },
            h('button', { type: 'button', className: 'rn-btn', onClick: props.onCancel }, t('cancel'))))
      }
      return h('div', { className: 'rn-form', key: props.key },
        h('div', { className: 'rn-form-head' }, t('publishTitle')),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('peer')),
          h('select', { className: 'rn-input', value: props.peerValue, onChange: props.onPeerChange },
            renderPeerOptions(peers))),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('publishPath')),
          h('input', {
            className: 'rn-input',
            type: 'text',
            value: props.path,
            placeholder: t('publishPathPlaceholder'),
            onChange: props.onPathChange,
          })),
        h('label', { className: 'rn-field' },
          h('span', { className: 'rn-field-label' }, t('publishDescription')),
          h('input', {
            className: 'rn-input',
            type: 'text',
            value: props.description,
            placeholder: t('publishDescriptionPlaceholder'),
            onChange: props.onDescriptionChange,
          })),
        h('div', { className: 'rn-form-actions' },
          h('button', { type: 'button', className: 'rn-btn', onClick: props.onCancel }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'rn-btn rn-btn-primary',
            disabled: props.busy,
            onClick: props.onPublish,
          }, props.busy ? t('publishing') : t('doPublish'))))
    }

    function renderFlash(flash, onDismiss) {
      if (!isObject(flash) || asText(flash.text) === '') return null
      return h('div', {
        key: 'rn-flash',
        className: 'rn-alert' + (flash.kind === 'ok' ? ' rn-alert-ok' : ''),
        role: flash.kind === 'ok' ? 'status' : 'alert',
      },
        h('span', null, asText(flash.text)),
        h('button', { type: 'button', className: 'rn-alert-close', 'aria-label': t('dismiss'), onClick: onDismiss }, '×'))
    }

    // ------------------------------------------------------------
    // 转录事件
    // ------------------------------------------------------------
    function renderEventRow(event, index) {
      const item = isObject(event) ? event : {}
      const kind = eventKind(item)
      const seq = numOrNull(item.seq)
      const time = numOrNull(item.time)
      const meta = []
      if (seq !== null) meta.push('#' + String(seq))
      if (time !== null && time > 0) meta.push(fmtClock(time))
      const head = h('div', { className: 'rn-event-head' },
        h('span', { className: 'rn-event-role rn-event-role-' + kind }, roleLabel(kind, item)),
        meta.length > 0 ? h('span', { className: 'rn-event-meta' }, meta.join(' · ')) : null)

      let body = null
      if (kind === 'user' || kind === 'assistant') {
        body = h('div', { className: 'rn-event-text' }, clipText(item.text))
      } else if (kind === 'tool-call') {
        const args = asText(item.args)
        body = h('div', { className: 'rn-event-tool' },
          h('div', { className: 'rn-event-tool-name' }, textOr(item.name, t('unknownTool'))),
          args !== '' ? h('pre', { className: 'rn-event-pre' }, clipText(args)) : null)
      } else if (kind === 'tool-result') {
        body = h('div', { className: 'rn-event-tool' + (item.isError === true ? ' rn-event-tool-error' : '') },
          h('div', { className: 'rn-event-tool-name' }, textOr(item.name, t('toolResult'))),
          h('pre', { className: 'rn-event-pre' }, clipText(item.text)))
      } else if (kind === 'deliverable') {
        const files = asArray(item.files)
        body = h('div', { className: 'rn-event-files' },
          h('div', { className: 'rn-event-tool-name' }, t('deliverablesPresented')),
          files.length === 0
            ? h('div', { className: 'rn-event-text' }, t('noFiles'))
            : files.map(function (file, index) {
              const entry = isObject(file) ? file : {}
              const path = asText(entry.path)
              const description = asText(entry.description)
              return h('div', { className: 'rn-event-file', key: 'file-' + String(index) },
                h('span', { className: 'rn-event-file-path' }, path === '' ? t('emptyValue') : path),
                description !== '' ? h('span', { className: 'rn-event-file-desc' }, description) : null)
            }))
      } else if (kind === 'turn') {
        const text = asText(item.type) === 'turn/end'
          ? t('turnEnd') + (asText(item.reason) !== '' ? '：' + asText(item.reason) : '')
          : t('turnStart') + (numOrNull(item.turn) !== null ? ' #' + String(numOrNull(item.turn)) : '')
        body = h('div', { className: 'rn-event-turn-line' }, text)
      } else {
        const type = textOr(item.type, t('roleEvent'))
        const text = asText(item.text)
        body = h('div', { className: 'rn-event-meta-line' }, type + (text !== '' ? '：' + clipText(text) : ''))
      }

      const key = 'event-' + String(index) + '-' + String(seq === null ? 'x' : seq)
      return h('div', { className: 'rn-event rn-event-' + kind, key: key }, head, body)
    }

    // ------------------------------------------------------------
    // 侧栏图标（接收 { size, active }）
    // ------------------------------------------------------------
    function PanelIcon(props) {
      try {
        const size = props && typeof props.size === 'number' && isFinite(props.size) && props.size > 0 ? props.size : 20
        const active = Boolean(props && props.active)
        return h('svg', {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
        },
        h('circle', { cx: 5, cy: 12, r: 2.6, fill: 'currentColor' }),
        h('circle', { cx: 19, cy: 12, r: 2.6, fill: 'currentColor' }),
        h('path', { d: 'M8 12h8', stroke: 'currentColor', strokeWidth: 1.8, fill: 'none' }),
        h('path', { d: 'M9.5 8.5L12 6l2.5 2.5M9.5 15.5L12 18l2.5-2.5', stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }))
      } catch (error) {
        return h('span', { 'aria-hidden': true })
      }
    }

    // ------------------------------------------------------------
    // 会话详情（独立组件：自己的转录轮询 / 发送 / 取消）
    // ------------------------------------------------------------
    function SessionDetail(props) {
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
      const fallbackSession = props && isObject(props.fallbackSession) ? props.fallbackSession : null
      const onBack = props && typeof props.onBack === 'function' ? props.onBack : function () {}

      const transcript = useTranscript(sessionId)
      const [text, setText] = useState('')
      const [sending, setSending] = useState(false)
      const [cancelling, setCancelling] = useState(false)
      const [flash, setFlash] = useState(null)
      const scrollRef = useRef(null)
      const stickRef = useRef(true)

      const events = transcript.events
      const session = transcript.session || fallbackSession
      const state = session && typeof session.state === 'string' ? session.state : ''
      const running = state === 'running' || state === 'starting'

      useEffect(function () {
        try {
          const element = scrollRef.current
          if (!element) return
          if (stickRef.current) element.scrollTop = element.scrollHeight
        } catch (error) {
          // 滚动失败只影响体验。
        }
      }, [events.length, transcript.loading])

      function onScroll(event) {
        try {
          const element = event && event.target ? event.target : null
          if (!element) return
          stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        } catch (error) {
          // 忽略。
        }
      }

      function onSend() {
        if (sending || sessionId === '') return
        const body = text.trim()
        if (body === '') return
        setSending(true)
        setFlash(null)
        apiPost('/session/prompt', { sessionId: sessionId, text: body, mode: 'queue' }).then(function () {
          setSending(false)
          setText('')
          setFlash({ kind: 'ok', text: t('promptSent') })
          stickRef.current = true
          transcript.reload()
        }).catch(function (failure) {
          setSending(false)
          setFlash({ kind: 'error', text: errText(failure) })
        })
      }

      function onCancel() {
        if (cancelling || sessionId === '') return
        setCancelling(true)
        setFlash(null)
        apiPost('/session/cancel', { sessionId: sessionId }).then(function () {
          setCancelling(false)
          setFlash({ kind: 'ok', text: t('cancelRequested') })
          transcript.reload()
        }).catch(function (failure) {
          setCancelling(false)
          setFlash({ kind: 'error', text: errText(failure) })
        })
      }

      function onKeyDown(event) {
        if (!event || event.key !== 'Enter') return
        if (!event.ctrlKey && !event.metaKey) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        onSend()
      }

      function onTextChange(event) {
        setText(event && event.target && typeof event.target.value === 'string' ? event.target.value : '')
      }

      try {
        const title = session && session.title !== '' ? session.title : t('sessionDetail')
        const subParts = []
        if (session) {
          subParts.push(session.peerNodeId !== '' ? session.peerNodeId : t('unknownPeer'))
          subParts.push(sessionDirectionText(session.direction))
          if (session.updatedAt !== null && session.updatedAt > 0) subParts.push(fmtAgo(session.updatedAt))
          if (session.lastSeq !== null) subParts.push(t('eventsLabel') + ' ' + String(session.lastSeq))
          subParts.push(t('deliverableCountLabel') + ' ' + String(session.deliverableCount))
        } else {
          subParts.push(shortId(sessionId, 46))
        }

        const transcriptBody = transcript.loading && events.length === 0
          ? h('div', { className: 'rn-empty' }, t('loadingTranscript'))
          : events.length === 0
            ? h('div', { className: 'rn-empty' }, t('noTranscript'))
            : events.map(renderEventRow)

        return h('div', { className: 'rn-root' },
          StyleTag(),
          h('header', { className: 'rn-header rn-detail-header', key: 'header' },
            h('div', { className: 'rn-detail-head-left' },
              h('button', { type: 'button', className: 'rn-btn', onClick: onBack }, '← ' + t('back')),
              h('div', { className: 'rn-header-text' },
                h('h2', { className: 'rn-title rn-detail-title', title: title }, title),
                h('div', { className: 'rn-sub' }, subParts.filter(function (part) { return part !== '' }).join(' · ')))),
            h('div', { className: 'rn-header-actions' },
              session ? h('span', { className: sessionBadgeClass(state) }, sessionStateText(state)) : null,
              h('button', { type: 'button', className: 'rn-btn', onClick: transcript.reload }, t('refresh')))),
          renderFlash(flash, function () { setFlash(null) }),
          transcript.error !== ''
            ? h('div', { className: 'rn-alert', role: 'alert' },
              h('span', null, t('stateError') + '：' + transcript.error))
            : null,
          session === null && sessionId !== ''
            ? h('div', { className: 'rn-empty' }, t('sessionGone'))
            : null,
          h('div', { className: 'rn-detail' },
            h('div', { className: 'rn-transcript', ref: scrollRef, onScroll: onScroll }, transcriptBody),
            h('div', { className: 'rn-composer' },
              h('textarea', {
                className: 'rn-textarea rn-prompt',
                rows: 3,
                value: text,
                placeholder: t('promptPlaceholder'),
                onChange: onTextChange,
                onKeyDown: onKeyDown,
              }),
              h('div', { className: 'rn-composer-foot' },
                h('span', { className: 'rn-hint' }, t('sendHint')),
                h('div', { className: 'rn-composer-actions' },
                  running
                    ? h('button', {
                      type: 'button',
                      className: 'rn-btn',
                      disabled: cancelling,
                      onClick: onCancel,
                    }, cancelling ? t('cancelling') : t('cancelRun'))
                    : null,
                  h('button', {
                    type: 'button',
                    className: 'rn-btn rn-btn-primary',
                    disabled: sending || text.trim() === '',
                    onClick: onSend,
                  }, sending ? t('sending') : t('send')))))))
      } catch (failure) {
        return h('div', { className: 'rn-root' },
          StyleTag(),
          h('header', { className: 'rn-header', key: 'header' },
            h('div', { className: 'rn-header-text' },
              h('h2', { className: 'rn-title' }, t('detailRenderFailed'))),
            h('div', { className: 'rn-header-actions' },
              h('button', { type: 'button', className: 'rn-btn', onClick: onBack }, '← ' + t('back')))),
          h('div', { className: 'rn-alert', role: 'alert' },
            h('span', null, t('detailRenderFailed') + '：' + errText(failure))))
      }
    }

    // ------------------------------------------------------------
    // 主面板
    // ------------------------------------------------------------
    function Page() {
      const polling = useSnapshotPolling()
      const [view, setView] = useState(null)
      const [openForm, setOpenForm] = useState(null)
      const [flash, setFlash] = useState(null)
      const [busy, setBusy] = useState('')
      const [peerPick, setPeerPick] = useState('')
      const [startPrompt, setStartPrompt] = useState('')
      const [publishPeer, setPublishPeer] = useState('')
      const [publishPath, setPublishPath] = useState('')
      const [publishDesc, setPublishDesc] = useState('')
      const [addOpen, setAddOpen] = useState(false)
      const [addName, setAddName] = useState('')
      const [addHost, setAddHost] = useState('')
      const [addPort, setAddPort] = useState('')
      const [addToken, setAddToken] = useState('')
      const [tokenVisible, setTokenVisible] = useState(false)
      const [confirmRemove, setConfirmRemove] = useState('')
      const [listenOpen, setListenOpen] = useState(false)
      const [listenEnabled, setListenEnabled] = useState(true)
      const [listenHost, setListenHost] = useState('')
      const [listenPort, setListenPort] = useState('')
      const [listenSaving, setListenSaving] = useState(false)
      const [listenError, setListenError] = useState('')

      const data = polling.data
      const reload = polling.reload

      /** 统一动作包装：busy / flash / 完成后刷新状态。 */
      const run = useCallback(function (label, work, okText) {
        setBusy(label)
        setFlash(null)
        return Promise.resolve().then(work).then(function (body) {
          setBusy('')
          if (typeof okText === 'string' && okText !== '') setFlash({ kind: 'ok', text: okText })
          reload()
          return body
        }).catch(function (failure) {
          setBusy('')
          setFlash({ kind: 'error', text: errText(failure) })
          return null
        })
      }, [reload])

      const peers = data ? data.peers : []
      const sessions = data ? data.sessions : []
      const deliverables = data ? data.deliverables : []
      const pairing = data ? data.pairing : null
      const pendingPairs = data ? data.pendingPairs : []

      function firstPeerId() {
        for (const peer of peers) {
          if (peer.peerNodeId !== '') return peer.peerNodeId
        }
        return ''
      }
      function pickPeer() {
        const preferred = openForm === 'publish' ? publishPeer : peerPick
        const found = peers.some(function (peer) { return peer.peerNodeId === preferred && preferred !== '' })
        return found ? preferred : firstPeerId()
      }

      function onRefreshClick() {
        if (busy === 'refresh') return
        run('refresh', function () { return apiPost('/refresh', {}) }, t('refresh') + ' ✓')
      }

      function onToggleForm(name) {
        setOpenForm(openForm === name ? null : name)
        setFlash(null)
      }

      function onStartSession() {
        if (busy === 'start') return
        const peerNodeId = pickPeer()
        if (peerNodeId === '') {
          setFlash({ kind: 'error', text: t('noPeerForAction') })
          return
        }
        const payload = { peerNodeId: peerNodeId }
        const prompt = startPrompt.trim()
        if (prompt !== '') payload.prompt = prompt
        run('start', function () { return apiPost('/session/start', payload) }, t('newSession') + ' ✓').then(function (body) {
          if (!body) return
          setStartPrompt('')
          setOpenForm(null)
          const created = isObject(body.session) ? body.session : null
          const createdId = created && typeof created.id === 'string' ? created.id : ''
          if (createdId !== '') setView(createdId)
        })
      }

      function onPublish() {
        if (busy === 'publish') return
        const peerNodeId = pickPeer()
        if (peerNodeId === '') {
          setFlash({ kind: 'error', text: t('noPeerForAction') })
          return
        }
        const path = publishPath.trim()
        if (path === '') {
          setFlash({ kind: 'error', text: t('needPath') })
          return
        }
        const payload = { peerNodeId: peerNodeId, path: path }
        const description = publishDesc.trim()
        if (description !== '') payload.description = description
        run('publish', function () { return apiPost('/publish', payload) }, t('published')).then(function (body) {
          if (!body) return
          setPublishPath('')
          setPublishDesc('')
          setOpenForm(null)
        })
      }

      function onFetchArtifact(item) {
        if (!isObject(item) || item.key === '') return
        const label = 'artifact:' + item.key
        if (busy === label) return
        const fetcher = apiPost('/artifact/fetch', { key: item.key })
        run(label, function () { return withTimeout(fetcher, 35000) }, t('fetched') + '：' + item.name)
      }

      function onOpenSession(id) {
        if (typeof id !== 'string' || id === '') return
        setView(id)
        setFlash(null)
      }

      // —— v1.1 配对 / 审批 / 删除 ——

      function onOpenAddNode() {
        setAddOpen(true)
        setFlash(null)
      }

      function onCloseAddNode() {
        // 配对请求进行中（可能数秒）不允许关闭，避免用户误以为已取消。
        if (busy === 'pair') return
        setAddOpen(false)
      }

      function onPairSubmit() {
        if (busy === 'pair') return
        const host = addHost.trim()
        const portText = addPort.trim()
        const token = addToken.trim()
        const port = Number(portText)
        if (host === '') {
          setFlash({ kind: 'error', text: t('needHost') })
          return
        }
        if (!isFinite(port) || port <= 0 || port > 65535 || Math.floor(port) !== port) {
          setFlash({ kind: 'error', text: t('needPort') })
          return
        }
        if (token === '') {
          setFlash({ kind: 'error', text: t('needToken') })
          return
        }
        const payload = { host: host, port: port, token: token }
        const nodeName = addName.trim()
        if (nodeName !== '') payload.nodeName = nodeName
        run('pair', function () { return apiPost('/peers/pair', payload) }, '').then(function (body) {
          if (!body) return
          const peer = isObject(body.peer) ? body.peer : null
          const label = peer === null ? '' : textOr(peer.nodeName, textOr(peer.peerNodeId, ''))
          setFlash({ kind: 'ok', text: t('pairSuccess') + (label !== '' ? '：' + label : '') })
          setAddOpen(false)
          setAddName('')
          setAddHost('')
          setAddPort('')
          setAddToken('')
        })
      }

      function onCopyToken() {
        const token = pairing && typeof pairing.token === 'string' ? pairing.token : ''
        if (token === '') return
        function finish(ok) {
          setFlash(ok ? { kind: 'ok', text: t('copied') } : { kind: 'error', text: t('copyFailed') })
        }
        try {
          if (typeof navigator !== 'undefined' && navigator && navigator.clipboard
            && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(token).then(function () { finish(true) }, function () { finish(false) })
            return
          }
        } catch (error) {
          // 落到失败提示。
        }
        finish(false)
      }

      function onToggleToken() {
        setTokenVisible(tokenVisible !== true)
      }

      function onRotateToken() {
        if (!pairing || pairing.fixedByConfig) return
        if (busy === 'rotate') return
        run('rotate', function () { return apiPost('/pairing/rotate', {}) }, t('tokenRotated'))
      }

      function onApprovePair(pair) {
        if (!isObject(pair) || pair.requestId === '') return
        const label = 'approve:' + pair.requestId
        if (busy === label) return
        run(label, function () {
          return apiPost('/peers/approve', { requestId: pair.requestId, approve: true })
        }, t('pairApproved'))
      }

      function onRejectPair(pair) {
        if (!isObject(pair) || pair.requestId === '') return
        const label = 'reject:' + pair.requestId
        if (busy === label) return
        run(label, function () {
          return apiPost('/peers/approve', { requestId: pair.requestId, approve: false })
        }, t('pairRejected'))
      }

      function onAskRemove(peer) {
        if (!isObject(peer) || peer.peerNodeId === '') return
        setConfirmRemove(peer.peerNodeId)
        setFlash(null)
      }

      function onCancelRemove() {
        setConfirmRemove('')
      }

      function onConfirmRemove(peer) {
        if (!isObject(peer) || peer.peerNodeId === '') return
        const label = 'remove:' + peer.peerNodeId
        if (busy === label) return
        run(label, function () {
          return apiPost('/peers/remove', { peerNodeId: peer.peerNodeId })
        }, t('nodeRemoved')).then(function (body) {
          if (body) setConfirmRemove('')
        })
      }

      // —— v1.2 监听设置（§11.4）——

      function onOpenListen() {
        const listen = self && isObject(self.listen) ? self.listen : null
        setListenEnabled(listen === null ? true : listen.enabled === true)
        setListenHost(listen !== null && listen.host !== '' ? listen.host : '127.0.0.1')
        setListenPort(listen !== null && listen.port !== null ? String(listen.port) : '')
        setListenError('')
        setListenOpen(true)
        setFlash(null)
      }

      function onCloseListen() {
        if (listenSaving) return
        setListenOpen(false)
      }

      function onListenSave() {
        if (listenSaving) return
        const host = listenHost.trim()
        const portText = listenPort.trim()
        const port = Number(portText)
        if (host === '') {
          setListenError(t('needListenHost'))
          return
        }
        if (!isFinite(port) || port <= 0 || port > 65535 || Math.floor(port) !== port) {
          setListenError(t('needListenPort'))
          return
        }
        setListenSaving(true)
        setListenError('')
        apiPost('/listen', { enabled: listenEnabled === true, host: host, port: port }).then(function (body) {
          setListenSaving(false)
          setListenOpen(false)
          const listen = isObject(body) && isObject(body.listen) ? body.listen : null
          setFlash({
            kind: 'ok',
            text: t('listenSaved') + (listen === null ? '' : '：' + listenText(listen)),
          })
          reload()
        }).catch(function (failure) {
          // 端口占用 / 权限不足等后端错误按原文展示在弹窗内。
          setListenSaving(false)
          setListenError(errText(failure))
        })
      }

      function onListenReset() {
        if (busy === 'listen-reset') return
        run('listen-reset', function () { return apiPost('/listen', { reset: true }) }, t('listenResetDone'))
      }

      const peerValue = pickPeer()
      const forms = []
      if (openForm === 'start') {
        forms.push(renderStartForm({
          key: 'start-form',
          peers: peers,
          peerValue: peerValue,
          prompt: startPrompt,
          busy: busy === 'start',
          onPeerChange: function (event) {
            setPeerPick(event && event.target ? asText(event.target.value) : '')
          },
          onPromptChange: function (event) {
            setStartPrompt(event && event.target ? asText(event.target.value) : '')
          },
          onStart: onStartSession,
          onCancel: function () { setOpenForm(null) },
        }))
      }
      if (openForm === 'publish') {
        forms.push(renderPublishForm({
          key: 'publish-form',
          peers: peers,
          peerValue: peerValue,
          path: publishPath,
          description: publishDesc,
          busy: busy === 'publish',
          onPeerChange: function (event) {
            setPublishPeer(event && event.target ? asText(event.target.value) : '')
          },
          onPathChange: function (event) {
            setPublishPath(event && event.target ? asText(event.target.value) : '')
          },
          onDescriptionChange: function (event) {
            setPublishDesc(event && event.target ? asText(event.target.value) : '')
          },
          onPublish: onPublish,
          onCancel: function () { setOpenForm(null) },
        }))
      }

      const self = data ? data.self : null
      const subLine = [renderSelfLine(self)]
      const updatedLine = fmtUpdatedLine(polling.updatedAt)
      if (updatedLine !== '') subLine.push(updatedLine)

      const errorBars = []
      if (polling.error !== '') {
        errorBars.push(h('div', { className: 'rn-alert', role: 'alert', key: 'poll-error' },
          h('span', null, t('stateError') + '：' + polling.error + ' ' + t('retryHint'))))
      }
      const flashBar = renderFlash(flash, function () { setFlash(null) })
      if (flashBar !== null) errorBars.push(flashBar)
      const warnings = data && Array.isArray(data.warnings) ? data.warnings : []
      if (warnings.length > 0) {
        errorBars.push(h('div', { className: 'rn-alert rn-alert-warn', role: 'status', key: 'config-warnings' },
          h('span', null, t('configWarnings') + '：' + warnings.join('；'))))
      }

      try {
        if (view !== null) {
          let fallbackSession = null
          for (const session of sessions) {
            if (session.id === view) {
              fallbackSession = session
              break
            }
          }
          return h(SessionDetail, {
            key: 'detail:' + view,
            sessionId: view,
            fallbackSession: fallbackSession,
            onBack: function () { setView(null) },
          })
        }

        const header = h('header', { className: 'rn-header', key: 'header' },
          h('div', { className: 'rn-header-text' },
            h('h2', { className: 'rn-title' }, t('title')),
            h('div', { className: 'rn-sub', title: self && self.dataDir !== '' ? t('dataDir') + ' ' + self.dataDir : '' }, subLine.join(' · '))),
          h('div', { className: 'rn-header-actions' },
            h('button', {
              type: 'button',
              className: 'rn-btn rn-btn-primary',
              disabled: busy === 'refresh',
              onClick: onRefreshClick,
            }, busy === 'refresh' ? t('refreshing') : t('refresh')),
            h('button', {
              type: 'button',
              className: 'rn-btn' + (addOpen ? ' rn-btn-active' : ''),
              onClick: onOpenAddNode,
            }, t('addNode')),
            h('button', {
              type: 'button',
              className: 'rn-btn' + (openForm === 'start' ? ' rn-btn-active' : ''),
              onClick: function () { onToggleForm('start') },
            }, t('newSession')),
            h('button', {
              type: 'button',
              className: 'rn-btn' + (openForm === 'publish' ? ' rn-btn-active' : ''),
              onClick: function () { onToggleForm('publish') },
            }, t('publish'))))

        const scrollChildren = []
        if (data === null && polling.error === '') {
          scrollChildren.push(h('div', { className: 'rn-empty', key: 'loading' }, t('loadingState')))
        }
        scrollChildren.push(renderListenCard(self, {
          busy: busy,
          onEdit: onOpenListen,
          onReset: onListenReset,
        }))
        scrollChildren.push(renderPairingBar(pairing, {
          visible: tokenVisible,
          busy: busy,
          onToggle: onToggleToken,
          onCopy: onCopyToken,
          onRotate: onRotateToken,
        }))
        scrollChildren.push(renderPendingPairsSection(pendingPairs, {
          busy: busy,
          onApprove: onApprovePair,
          onReject: onRejectPair,
        }))
        scrollChildren.push(renderLinksSection(peers, {
          busy: busy,
          confirmRemove: confirmRemove,
          onAskRemove: onAskRemove,
          onCancelRemove: onCancelRemove,
          onConfirmRemove: onConfirmRemove,
        }))
        scrollChildren.push(renderSessionsSection(sessions, onOpenSession))
        scrollChildren.push(renderDeliverablesSection(deliverables, busy, onFetchArtifact))

        const addModal = addOpen
          ? renderAddNodeModal({
            busy: busy,
            name: addName,
            host: addHost,
            port: addPort,
            token: addToken,
            onNameChange: function (event) {
              setAddName(event && event.target ? asText(event.target.value) : '')
            },
            onHostChange: function (event) {
              setAddHost(event && event.target ? asText(event.target.value) : '')
            },
            onPortChange: function (event) {
              setAddPort(event && event.target ? asText(event.target.value) : '')
            },
            onTokenChange: function (event) {
              setAddToken(event && event.target ? asText(event.target.value) : '')
            },
            onSubmit: onPairSubmit,
            onClose: onCloseAddNode,
          })
          : null

        const listenModal = listenOpen
          ? renderListenModal({
            saving: listenSaving,
            enabled: listenEnabled,
            host: listenHost,
            port: listenPort,
            error: listenError,
            onEnabledChange: function (event) {
              setListenEnabled(Boolean(event && event.target && event.target.checked))
              setListenError('')
            },
            onHostChange: function (event) {
              setListenHost(event && event.target ? asText(event.target.value) : '')
              setListenError('')
            },
            onPortChange: function (event) {
              setListenPort(event && event.target ? asText(event.target.value) : '')
              setListenError('')
            },
            onSave: onListenSave,
            onClose: onCloseListen,
          })
          : null

        return h('div', { className: 'rn-root' },
          StyleTag(),
          header,
          errorBars,
          forms,
          h('div', { className: 'rn-scroll' }, scrollChildren),
          addModal,
          listenModal)
      } catch (failure) {
        return h('div', { className: 'rn-root' },
          StyleTag(),
          h('header', { className: 'rn-header', key: 'header' },
            h('div', { className: 'rn-header-text' },
              h('h2', { className: 'rn-title' }, t('renderFailed')))),
          h('div', { className: 'rn-alert', role: 'alert' },
            h('span', null, t('renderFailed') + '：' + errText(failure))))
      }
    }

    // ------------------------------------------------------------
    // 本地化：注册 zh/en 字典并绑定翻译函数（失败静默回退 zh）
    // ------------------------------------------------------------
    function setupLocale(ctx) {
      function attach(locale) {
        if (!locale) return
        try {
          if (typeof locale.register === 'function') {
            try {
              locale.register(NS, { zh: ZH, en: EN })
            } catch (error) {
              // HMR 重载 / 已有同名命名空间：逐语言兜底注册。
              try { locale.register(NS, 'zh', ZH) } catch (ignoreZh) { /* 已存在 */ }
              try { locale.register(NS, 'en', EN) } catch (ignoreEn) { /* 已存在 */ }
            }
          }
          if (typeof locale.bind === 'function') {
            const bound = locale.bind(NS)
            if (typeof bound === 'function') translate = bound
          }
        } catch (error) {
          // 保留 zh 回退字典。
        }
      }
      let locale = null
      try {
        locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null
      } catch (error) {
        locale = null
      }
      if (locale) {
        attach(locale)
        return
      }
      if (ctx && typeof ctx.inject === 'function') {
        try {
          ctx.inject(['locale'], function (localeCtx) {
            let resolved = null
            try { resolved = localeCtx && localeCtx.locale ? localeCtx.locale : null } catch (error) { resolved = null }
            if (!resolved && localeCtx && typeof localeCtx.get === 'function') {
              try { resolved = localeCtx.get('locale') } catch (error) { resolved = null }
            }
            attach(resolved)
          })
        } catch (error) {
          // 回退语言继续可用。
        }
      }
    }

    // ------------------------------------------------------------
    // 插件入口
    // ------------------------------------------------------------
    function registerSlots(slots) {
      function safeInject(key, options, component) {
        try {
          slots.inject(key, function () {
            return slots.register(options, component)
          })
        } catch (error) {
          // 单个插槽注册失败不影响另一个落点。
          try {
            if (typeof console !== 'undefined' && typeof console.error === 'function') {
              console.error('[remotenode] slot registration failed: ' + key, error)
            }
          } catch (ignore) {
            // 忽略。
          }
        }
      }
      safeInject('sidebar.panellist', {
        name: 'sidebar.panellist',
        id: 'remotenode',
        order: 20,
        label: function () { return t('nav') },
        locale: NS,
      }, PanelIcon)
      safeInject('main', {
        name: 'main',
        key: 'remotenode',
        locale: NS,
      }, Page)
    }

    function apply(ctx) {
      try {
        setupLocale(ctx)
        let slots = null
        try { slots = ctx && ctx.slots ? ctx.slots : null } catch (error) { slots = null }
        if (!slots && ctx && typeof ctx.get === 'function') {
          try { slots = ctx.get('slots') } catch (error) { slots = null }
        }
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
        registerSlots(slots)
      } catch (error) {
        // 插件入口绝不能抛出（会拖垮 client 加载）：只记录。
        try {
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[remotenode] client apply failed:', error)
          }
        } catch (ignore) {
          // 忽略。
        }
      }
    }

    return { inject: ['slots'], apply: apply }
  },
})
