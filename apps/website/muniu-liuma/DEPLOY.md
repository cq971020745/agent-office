# 木牛流马官网部署

## 地址

- 官网：`http://139.196.147.134/AI/muniu-liuma/`

（nginx `root` 为 `/var/chenqiang`，官网路径带 `/AI/`。安装包用 ASCII 文件名。）

注意：本服务器 `8787` 已被 API Hub 占用；木牛流马桌面一体包内嵌服务端，不抢该端口。浏览器自建请另开端口。

## 目录结构

```
/var/chenqiang/AI/muniu-liuma/
  index.html
  latest.json
  assets/shot-*.jpg
  releases/0.1.0/
    Muni-0.1.0-win-x64-Setup.exe
    Muni-0.1.0-mac-arm64.dmg
    Muni-0.1.0-mac-x64.dmg
```


## Mac「已损坏」

未使用 Apple 开发者证书时，用户从网上下载后可能被隔离。官网页已写说明；终端执行：

```bash
xattr -cr /Applications/木牛流马.app
```

请勿用微信转发安装包。从官网直接下。重新打包请用 ad-hoc 签名（`identity: "-"`，见 `electron-builder.yml` / Pack macOS workflow）。
