# 木牛流马官网部署

## 上传（Xftp）

本机已打好与服务器同构的目录：

`D:\Projects\agent-group\muniu-liuma-site\`

用 Xftp 整夹上传到服务器：

`/var/chenqiang/AI/muniu-liuma/`

上传后结构应为：

```
/var/chenqiang/AI/muniu-liuma/
  index.html
  latest.json
  releases/0.1.0/
    木牛流马-0.1.0-win-x64-Setup.exe
    木牛流马-0.1.0-mac-arm64.dmg
    木牛流马-0.1.0-mac-x64.dmg
```

访问：`http://139.196.147.134/muniu-liuma/`

## 若打开 404

确认现有站点文档根是否已指向 `/var/chenqiang/AI`。若不是，在 nginx 对应 server 中增加：

```nginx
location /muniu-liuma/ {
  alias /var/chenqiang/AI/muniu-liuma/;
  index index.html;
  # 大安装包直链
  sendfile on;
  aio threads;
}
```

改完后：`nginx -t && nginx -s reload`

## Mac「已损坏」

未使用 Apple 开发者证书时，用户从网上下载后可能被隔离。官网页已写说明；终端执行：

```bash
xattr -cr /Applications/木牛流马.app
```

请勿用微信转发安装包。从官网直接下。重新打包请用 ad-hoc 签名（`identity: "-"`，见 `electron-builder.yml` / Pack macOS workflow）。
