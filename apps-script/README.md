# 趣仓运营管理后台 · Apps Script（待绑定）

本目录是唯一读写接口的 Apps Script 源码，预定绑定到新数据库：

https://docs.google.com/spreadsheets/d/18KIviTyEjxjxav2v0a3liRwlUI8L8O9anjceRi8En9M/edit

专属文件夹：

https://drive.google.com/drive/folders/1mz1Dmn0rrKjhNSIFBvr3_hPjgda87pUo

## 当前状态

本预览包交付时，脚本**尚未**绑定到表格，也**尚未**部署为 Web App。内部预览请先使用仓库根目录的本地适配器（`./start-preview.sh`）。不要把未部署写成已部署。

## 随后绑定步骤（不在本次自动执行）

1. 用有权编辑该新表的账号打开上述表格。
2. 扩展程序 → Apps Script，把 `Code.gs` 与 `appsscript.json` 粘贴进去。
3. 在脚本属性中设置（不要把密钥写进代码仓库）：
   - `DRIVE_ROOT_ID` = `1mz1Dmn0rrKjhNSIFBvr3_hPjgda87pUo`
4. 保存后，部署 → 新建部署 → 类型选「网络应用程序」；执行身份为部署者；访问对象按你的组织策略选择（不要对公众开放超出需要的权限）。
5. 记下 Web App URL。日后如要把正式站 `/admin/` 接到这套脚本，只改前端接口地址，不要再做第二套接口，也不要手工粘贴 `data.js`。
6. 不要给正式站绑定自定义域名，不要改 funstock.org 的 DNS，除非另行批准。

## 鉴权规则（必须保持）

- 找不到「10_授权用户」分表，或该表无法读取，必须拒绝，不得默认放行。
- 只核验密码哈希（`hmac-sha256$salt$hex`），表格正文不得出现明文密码。
- 鉴权失败即拒绝。

哈希算法与本地预览服务一致，便于同一批测试账号在绑定后继续使用（哈希已写入该新表时）。
