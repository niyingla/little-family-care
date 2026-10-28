我家日常小事簿
==============

温暖、简洁的家庭共享待办微信小程序。首版 ``release-0.1.0``，使用原生微信小程序，支持轻量Node.js服务器与微信云开发两种后端。

项目状态
--------

当前部署路径为自有Linux服务器：Node.js 24 + SQLite + Nginx。数据与私有头像保存在自己的服务器目录。微信云开发代码保留为备选，业务规则共用。正式微信登录、HTTPS域名、消息模板及真机联调需要开发者自己的账号配置。浏览器预览不代表微信真机验证；普通一次性订阅不能承诺一次授权后永久提醒。

功能
----

* **宝宝事项**：多宝宝姓名与头像；选择具体宝宝，单独完成和查看历史。
* **家庭事项**：不关联宝宝，记录家务、采购、办理事项等家庭安排。
* **周期**：仅一次、每天、每隔N天、每周指定星期；统一北京时间。
* **共享执行**：指定执行人，家人共同打勾与撤销；并发版本校验避免覆盖刚完成的记录。
* **重要事项置顶**：两大事项块分别显示；共享置顶状态，不改变周期和执行历史。
* **执行历史**：按日期查看应做、已完成、未完成及执行流水；任务编辑和停用从次日生效。
* **邀请制**：预设管理员创建家庭；24小时一次性邀请、管理员审批、成员移除后撤销访问。
* **执行时间与通知**：时间可留空；设置后超时30分钟仍未完成才通知。被通知人与执行人分别选择；显示实际发送状态，无额度时可手动分享通用任务卡片。

快速运行
--------

要求本地及自建后端 Node.js 24 或以上版本，使用内置SQLite。云函数备选模式的运行时需选择平台实际支持的兼容版本。

::

  npm ci
  npm test
  npm run check
  npm run format:check
  npm run preview

打开 ``http://127.0.0.1:4173``。示例家庭数据只保存在本机；演示模式不发送微信消息、不创建云资源。

自有服务器接入
--------------

将源码放在 ``/opt/little-family-care/current``，安装Node.js 24.15.0到 ``/opt/little-family-care/runtime``；参考 ``deploy/install.sh`` 安装独立系统服务。首次部署会生成私有签名密钥，不会生成假的微信凭据。真实配置保存在服务器 ``/etc/little-family-care.env``，权限600；数据库与头像保存在 ``/var/lib/little-family-care``，不在公开源码目录。

``GET /health`` 用于服务自检；``POST /api/login`` 使用wx.login返回的code换取服务器会话，``POST /api/call`` 使用会话调用家庭业务。头像以10分钟签名URL访问。请先配置微信AppID和AppSecret、唯一管理员OpenID及真实消息模板；这些值不提交Git。

前端在本地 ``config.local.js`` 填写 ``apiBaseUrl`` 的HTTPS域名。域名解析、证书和微信合法域名配置完成前，只能检查服务器接口，不能宣称正式小程序已接通。部署脚本启用HTTP，HTTPS需在域名与证书就绪后配置。Node进程只监听127.0.0.1:3000，外部通过Nginx访问80端口。

微信云开发备选接入
------------------

1. 注册微信小程序、完成类目及必要备案，导入项目时选择自己的 AppID。
2. 使用微信云开发的文档型数据库，绑定同一小程序与腾讯云账号。
3. 将 ``miniprogram/config.local.example.js`` 复制为 ``config.local.js``，填写环境和模板ID；真实配置被 Git 忽略。
4. 按 ``cloud-settings.example.json`` 创建集合，将客户端数据库和存储权限均设为禁止直读直写。
5. 云端安装依赖并部署 ``family``；配置唯一管理员 ``OWNER_OPENID``，只有此人能初始化家庭。
6. 配置实际可用的订阅消息模板与字段，然后部署 ``reminder`` 及每5分钟的定时触发器。
7. 两个微信账号分别验证邀请、审批、访问、执行、头像和消息后，再进行提审与发布。

完整步骤、数据边界和上线资料见 `setup.html <setup.html>`_。配置示例中的模板字段是假设，必须替换为实际获准模板，不得直接宣称通知可用。

目录与维护
----------

::

  miniprogram/pages/index/controllers/  时间线、任务、家庭的交互控制
  miniprogram/pages/index/templates/    各区域与表单WXML
  miniprogram/utils/domain.js           周期、权限、历史、置顶规则唯一来源
  server/service.cjs                   服务端事务、邀请和通知队列
  server/cloud.cjs                     微信云数据库和消息接口适配
  selfhost/                           HTTP、微信登录、SQLite与本地私有头像
  deploy/                             自建服务器配置、systemd与独立Nginx
  cloudfunctions/family/               家庭业务与私有头像上传入口
  cloudfunctions/reminder/             独立定时任务入口
  tests/                              业务规则、权限、并发和表单回归测试
  preview/                            复用实际页面控制器的浏览器预览桥
  scripts/                            准备、格式检查、结构检查和预览
  assets/                             原创应用图标

``server/domain.js`` 和两个云函数的 ``lib/`` 是构建复制结果。修改共用规则或服务端实现后运行 ``npm run prepare``，不要直接修改生成副本。小程序客户端不直连数据库；自建模式通过HTTPS访问业务入口，云开发模式通过云函数访问。

开发规范
--------

职责单一、重要业务方法补齐参数说明、中文注释说明业务边界；日志记录操作、数量与耗时，不打印微信身份、邀请码、图片内容或密钥。提交前运行测试、结构和格式检查；提交说明携带实际发布版本。不要提交真实宝宝信息、头像、OpenID、云配置或个人IDE配置。

已知边界
--------

家庭上限20名有效成员、10位宝宝、200项任务。头像限1MB内JPG或PNG；当前仅支持当天打勾，历史不支持补签。暂不提供家庭删除、宝宝删除、成员权限细分、每月重复或离线真实数据编辑。定时检查约5分钟，发送成功只代表微信接口接收，不代表对方已读。未知发送结果不盲目重发，需要结合日志处理。

参考
----

* `微信云函数接入 <https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram>`_
* `微信订阅消息 <https://docs.cloudbase.net/recipes/add-subscribe-message-cloud-function>`_
* `云数据库事务 <https://docs.cloudbase.net/database/transaction>`_
