# 趣仓运营管理后台 · Apps Script（待绑定）

本目录是唯一读写接口的 Apps Script 源码，预定绑定到新数据库：

https://docs.google.com/spreadsheets/d/18KIviTyEjxjxav2v0a3liRwlUI8L8O9anjceRi8En9M/edit

专属文件夹：

https://drive.google.com/drive/folders/1mz1Dmn0rrKjhNSIFBvr3_hPjgda87pUo

## 当前状态

本预览包交付时，脚本**尚未**绑定到表格，也**尚未**部署为 Web App。内部预览请先使用仓库根目录的本地适配器（`./start-preview.sh`）。不要把未部署写成已部署。

`Code.gs` 已按本地预览服务（`server/server.js` 与 `server/lib/`）同步月账与合同的完整校验：月结单轧差、现金/第三方上限、免原件、暂记往来、完成页与四套账定稿、合同状态机，以及资料上传与认领。对客正式合同生成（`generateOfficialContract`）保持关闭。本地可用 `node apps-script/test-rules.js` 跑规则与 action 对照（这是 Node 测试，不要把该文件粘贴进脚本项目）。

## 随后绑定步骤（不在本次自动执行）

1. 用有权编辑该新表的账号打开上述表格。
2. 扩展程序 → Apps Script，把 `Code.gs` 与 `appsscript.json` 粘贴进去。
3. 在脚本属性中设置（不要把密钥写进代码仓库）：
   - `DRIVE_ROOT_ID` = `1mz1Dmn0rrKjhNSIFBvr3_hPjgda87pUo`
4. 保存后，部署 → 新建部署 → 类型选「网络应用程序」；执行身份为部署者；访问对象按你的组织策略选择（不要对公众开放超出需要的权限）。
5. 记下 Web App URL。打开 `site/admin/js/config.js`，把 `window.FS_API_BASE` 设为该 URL（例如 `https://script.google.com/macros/s/…/exec`）。未填写时，后台仍走本机 `POST /api`（本地 8787 预览）。只改这一处接口地址，不要再做第二套接口，也不要手工粘贴 `data.js`。
6. 不要给正式站绑定自定义域名，不要改 funstock.org 的 DNS，除非另行批准。

绑定后，脚本在首次写入时如发现缺列，只会在表右侧**追加**字段，不删表、不改 00–12 表名。可能追加：

- `02_经营计划与法定提醒`：编号、回馈、回馈人、回馈时间
- `04_流水日记账`：来源键、月结单编号、操作记录
- `06_资料与凭证台账`：认领记录、上传人、MIME、大小
- `07_合同台账`：签署正本编号、首期凭证编号、双方协议文件编号、履约计划JSON、创建时间、创建人
- `09_隐私声明存证`：操作人
- 如尚不存在，会新建 `13_月账工作底稿`（月结单、现金收支与月账状态的工作底稿，不替代 04/05 台账）

## 前端如何调用（部署之后）

预览域名上的 GitHub Pages 只发布静态页，不能提供 `/api`。管理后台在 `FS_API_BASE` 已设置时，用 `Content-Type: text/plain;charset=utf-8` 把 JSON（含 `action`、`payload`、`token`）POST 到 Web App，并跟随重定向；登录令牌存在 `sessionStorage`，不能依赖跨域 cookie。上传文件在该路径下改为 JSON 内的 base64（`name`、`mime`、`data`），由脚本写入 Drive。公开网站页面不走此接口。

## 鉴权规则（必须保持）

- 找不到「10_授权用户」分表，或该表无法读取，必须拒绝，不得默认放行。脚本不改写该表。
- 只核验密码哈希（`hmac-sha256$salt$hex`），表格正文不得出现明文密码。
- 鉴权失败即拒绝。除 `login` 外的操作都经过 `requireUser_`。

哈希算法与本地预览服务一致，便于同一批测试账号在绑定后继续使用（哈希已写入该新表时）。
