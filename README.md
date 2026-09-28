# WP 批量管家

一个自己部署的 WordPress **多站点批量管理**工具，适合同时管理很多新闻站、文章站。
只需要为每个网站填写 **网址 + 用户名 + 应用密码**，就可以在一个界面里：

- **文章管理**：跨站点查询文章/页面（按状态、关键词、分类、标签、日期筛选），勾选后批量
  - 修改状态（发布 / 草稿 / 待审核 / 私密）
  - 添加、替换、移除分类和标签（按名称匹配，不存在可自动创建）
  - 查找替换标题/正文/摘要（支持先预览、区分大小写、正则表达式）
  - 开关评论、置顶
  - 移到回收站、从回收站恢复、永久删除
  - 单篇快速编辑
- **批量发布**：写一篇文章，同时发布到多个站点（支持分类、标签、定时发布、特色图片）
- **插件管理**：一览所有站点装了哪些插件、哪些启用；批量安装（WordPress.org 插件目录）、启用、停用、删除
- **网站设置**：批量修改副标题、时区、日期格式、每页文章数、评论默认设置、语言、管理员邮箱等；可以把某个站点的设置复制到其他站点
- **分类标签**：批量创建、查看各站点分布、批量删除
- **操作记录**：每次批量操作的逐项结果（成功/失败原因）都有记录，失败的项目可以一键重试

界面为简体中文，电脑和手机浏览器都可以使用。

---

## 一、运行

需要 [Node.js](https://nodejs.org/zh-cn) 18 或更高版本（没有其他依赖，不需要 `npm install`）。

| 方式 | 操作 |
| --- | --- |
| Windows | 双击 `start.bat`（想让同一 Wi-Fi 的手机也能访问，双击 `start-lan.bat`） |
| macOS / Linux | 运行 `./start.sh` |
| 命令行 | `npm start`（或 `node server.js`） |
| Docker | 修改 `docker-compose.yml` 里的密码后执行 `docker compose up -d` |

启动后浏览器打开 <http://localhost:8686>。

> `localhost` 指的是"正在运行本程序的这台设备"。在电脑上启动，就只能在这台电脑的浏览器里用 `localhost` 打开；
> 手机上直接打开 `localhost:8686` 是连不上的（会显示"拒绝连线"）。想用手机操作，请看下面的"在手机上使用"。

**第一次使用**：命令行窗口会显示一个带设置码的链接，例如

```
首次使用：请在浏览器中打开下面的链接来设置管理密码（链接里包含一次性设置码）：
  http://127.0.0.1:8686/?setup=xxxxxxxxxxxx
```

打开这个链接，设置一个**管理密码**（至少 8 位）。以后打开本程序都需要输入它——因为本程序保存着你所有网站的管理权限。

### 在手机上使用

**方法 A：电脑开着程序，手机连同一个 Wi-Fi 来操作**

1. Windows 电脑双击 `start-lan.bat`（macOS / Linux 运行 `HOST=0.0.0.0 ./start.sh`）
2. 如果 Windows 防火墙询问，勾选"专用网络"并允许
3. 命令行窗口会显示 `手机或其他电脑……请在浏览器打开：http://192.168.x.x:8686`，在手机浏览器输入这个地址

只在自己家里或公司的可信 Wi-Fi 这样用，不要在咖啡厅等公共 Wi-Fi 上开启。

**方法 B：只有 Android 手机，直接在手机上运行**

1. 从 [F-Droid](https://f-droid.org/packages/com.termux/) 安装 Termux（Google Play 上的版本太旧，不能用）
2. 打开 Termux，依次输入：

   ```bash
   pkg install -y nodejs-lts git
   git clone --depth 1 -b claude/wordpress-batch-management-c3t20n https://github.com/chris05160802/Wordpress.git wp-batch-manager
   cd wp-batch-manager
   node server.js --open
   ```

3. 手机浏览器会自动打开设置页面。使用期间不要关闭 Termux。
   以后再用：打开 Termux，输入 `cd wp-batch-manager && node server.js --open`；更新到新版本：在该目录执行 `git pull`。

iPhone 不能直接运行本程序，请用方法 A，或部署到服务器（见"六、部署到服务器"），就能在任何地方用手机访问。

## 二、添加站点

在「站点管理」里填写：

- **网站网址**：例如 `https://www.example.com`（子目录安装也可以，例如 `https://example.com/news`）
- **用户名**：WordPress 后台登录用的用户名
- **应用密码**：见下面的说明（**不是**后台登录密码）
- **分组**（可选）：例如"新闻站"、"文章站"。左侧可以按分组一键选中一批站点

### 什么是"应用密码"？怎么获取？

应用密码（Application Password）是 WordPress 5.6 起自带的功能，专门给外部程序调用接口用的：

1. 用管理员账号登录网站后台，进入 **用户 → 个人资料**
2. 页面下方找到 **应用程序密码**，名称填"批量管家"，点 **添加新应用程序密码**
3. 复制生成的密码（形如 `abcd efgh ijkl mnop qrst uvwx`，带不带空格都可以），粘贴到本程序

也可以在本程序里填好网址后点 **检测网站 → 打开授权页面**，在自己网站上登录并点"同意"即可生成。

为什么用应用密码而不是登录密码：

- 应用密码只能调用接口，**不能登录后台**，泄露的风险比登录密码小得多
- 网站开了两步验证、登录验证码、登录保护插件也不受影响
- 可以随时在后台 **单独撤销**，不影响你的登录密码

> 注意：WordPress 默认**只在 HTTPS 网站**上开启应用密码。如果网站已经是 HTTPS 仍然不能用，
> 可能是 Wordfence、iThemes Security、Disable REST API 等安全插件关闭了应用密码或 REST API，需要在插件设置里开启。

### 批量导入

站点多的话，可以在「批量导入站点」里一次粘贴很多行，每行一个：

```
网址,用户名,应用密码,分组
https://news1.com,admin,abcd efgh ijkl mnop qrst uvwx,新闻站
https://news2.com,admin,wxyz wxyz wxyz wxyz wxyz wxyz,新闻站
https://blog1.com,editor,aaaa bbbb cccc dddd eeee ffff,文章站
```

分隔符可以用英文逗号、中文逗号、`|` 或 Tab（直接从 Excel 复制即可）。每个站点都会先测试连接，成功的才会添加。

## 三、使用提示

- 所有批量操作都针对 **左侧勾选的站点**（或表格里勾选的文章/插件）。
- 每次批量操作会弹出进度窗口，逐项显示结果；关闭窗口不会中断任务，可以在「操作记录」里查看。
- 对同一个站点的请求会限速（每个站点同时最多 1～3 个请求，同时处理 4 个站点），避免把小主机压垮。
- 永久删除文章、删除插件需要输入"删除"二字确认。建议平时优先用"移到回收站"。
- 查找替换会直接修改文章原文（包括 HTML），建议先点"预览"看看每篇能匹配几处。
- 账号权限决定能做什么：编辑（Editor）账号可以管理文章、分类、标签，但插件和网站设置需要**管理员**账号。

## 四、限制说明

这些是 WordPress 官方接口（REST API）本身的限制：

- 插件只能从 **WordPress.org 官方插件目录**安装（填插件网址里的英文名称，例如 `wordpress-seo`）。付费插件或 zip 包需要在网站后台上传。
- **插件和 WordPress 升级**不能通过接口完成，请在后台升级，或开启自动更新。
- 主题只能在后台切换。
- "站点语言"只能切换到网站**已经安装**的语言包。

## 五、常见问题

**提示"身份验证失败：用户名或应用密码不正确"**

1. 确认填的是应用密码，不是登录密码；用户名区分大小写
2. 如果确认无误，可能是主机（常见于 Apache + CGI/FastCGI）把 `Authorization` 请求头丢掉了。
   在网站根目录的 `.htaccess` 里 `RewriteEngine On` 下面加一行：

   ```apache
   RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
   ```

**提示"没有找到 WordPress REST API"或"网站返回的不是有效的 JSON 数据"**

REST API 被安全插件、防火墙（如 CDN 的人机验证）拦截了。需要在安全插件里放行 REST API，或把运行本程序的电脑/服务器 IP 加入白名单。

**提示"无法从 WordPress.org 获取该插件"**

插件名称写错了，或者网站服务器本身连不上 WordPress.org（例如国内主机的网络问题）。

## 六、部署到服务器

默认只监听本机（`127.0.0.1`），只有这台电脑能访问。要放到服务器上给多人或手机使用：

1. 设置环境变量 `HOST=0.0.0.0`，并用 `WPBM_PASSWORD` 设置管理密码
2. **务必**在前面加一个 HTTPS 反向代理（例如 Nginx、Caddy），不要用 http 直接暴露在公网
3. 设置 `WPBM_TRUST_PROXY=1`（让程序识别 HTTPS 和真实 IP），并把访问域名加到 `WPBM_ALLOWED_HOSTS`

Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name wp-admin.example.com;
    # ssl_certificate ... ;

    client_max_body_size 30m;   # 上传特色图片
    location / {
        proxy_pass http://127.0.0.1:8686;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 900s;
    }
}
```

控制台用 HTTPS 访问时，「打开授权页面」生成应用密码后还会**自动跳回并添加站点**，不用手动复制粘贴。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8686` | 端口 |
| `HOST` | `127.0.0.1` | 监听地址；`0.0.0.0` 表示允许其他电脑访问 |
| `WPBM_DATA_DIR` | `./data` | 数据目录 |
| `WPBM_PASSWORD` | – | 首次启动时直接设置管理密码（适合 Docker / 服务器） |
| `WPBM_SECRET` | – | 用来加密应用密码的密钥；不设置则自动生成 `data/secret.key` |
| `WPBM_ALLOWED_HOSTS` | – | 允许的访问域名（逗号分隔），例如 `localhost,wp-admin.example.com` |
| `WPBM_TRUST_PROXY` | – | 设为 `1` 表示运行在反向代理后面 |

## 七、数据与安全

- 所有数据都保存在本机的 `data/` 目录，不会上传到任何第三方：
  - `sites.json`：站点列表，应用密码用 **AES-256-GCM 加密**保存
  - `secret.key`：加密密钥（**和 sites.json 一起备份**，丢了就需要重新填写应用密码）
  - `config.json`：管理密码的 scrypt 哈希
  - `history.json`：最近 100 次操作记录
- 管理密码错误 10 次会锁定 15 分钟；修改管理密码会让其他已登录的浏览器全部退出。
- 程序只会连接你添加的站点，使用 WordPress 官方的 REST API，不会绕过网站的任何安全设置。
- 不再使用某个站点时，除了在本程序里移除，也建议在该网站后台撤销对应的应用密码。

## 八、开发

```bash
npm test        # 运行测试（内置一个模拟的 WordPress REST API）
```

代码结构：

```
server.js            启动入口
src/wp-client.js     WordPress REST API 客户端（地址探测、认证、错误说明、重试）
src/actions.js       各种批量操作
src/queries.js       跨站点查询（文章、插件、设置、分类）
src/jobs.js          批量任务调度（按站点限速、取消、结果记录）
src/app.js           HTTP 接口
src/auth.js          管理密码与登录
src/store.js         本地数据存储（加密）
public/              网页界面（原生 JS，无需构建）
test/                测试
```
