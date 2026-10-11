# LumenPnP 本地调试工具 - 零依赖静态服务器
# 使用 Windows 自带 PowerShell 运行,无需安装 Python 或任何软件
# 关闭本窗口即停止服务
param([int]$Port = 8321)

$ErrorActionPreference = 'Stop'
# 网站根目录 = 本脚本所在目录
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 监听 localhost 端口(TcpListener 普通用户权限即可,无需管理员)
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " LumenPnP 本地调试工具服务已启动 (零依赖)" -ForegroundColor Green
Write-Host " 地址: http://localhost:$Port"
Write-Host " 按 Ctrl+C 或直接关闭本窗口即停止服务"
Write-Host "==========================================" -ForegroundColor Cyan

# 常见文件类型 MIME 映射
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';  '.js'  = 'text/javascript; charset=utf-8'
  '.png'  = 'image/png'; '.svg' = 'image/svg+xml'; '.jpg' = 'image/jpeg'
  '.jpeg' = 'image/jpeg'; '.gif' = 'image/gif'; '.ico' = 'image/x-icon'
  '.json' = 'application/json'
}
$enc = [System.Text.Encoding]::UTF8
$rootPrefix = $root.TrimEnd('\') + '\'

# 主循环:逐个接受并处理 HTTP 请求
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 5000
    $buf = New-Object byte[] 8192
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { continue }

    # 解析请求行,取出路径(GET /xxx HTTP/1.1)
    $req = $enc.GetString($buf, 0, $n)
    $parts = (($req -split "`r`n")[0]) -split ' '
    $path = '/'
    if ($parts.Count -ge 2) { $path = $parts[1] }
    $q = $path.IndexOf('?'); if ($q -ge 0) { $path = $path.Substring(0, $q) }
    $path = [System.Uri]::UnescapeDataString($path)
    if ($path -eq '/') { $path = '/index.html' }

    # 拼出磁盘上的完整路径,并防目录穿越攻击(不允许 .. 跳出根目录)
    $rel = $path.TrimStart('/').Replace('/', '\')
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

    $status = 200; $reason = 'OK'; $body = $null
    if (-not $full.StartsWith($rootPrefix) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $status = 404; $reason = 'Not Found'
      $body = $enc.GetBytes('404 Not Found')
      $ct = 'text/plain; charset=utf-8'
    } else {
      $body = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $ct = 'application/octet-stream'
      if ($mime.ContainsKey($ext)) { $ct = $mime[$ext] }
    }

    # 应答头(每次连接关闭,浏览器会自己重连)
    $head = "HTTP/1.1 $status $reason`r`nContent-Type: $ct`r`nContent-Length: $($body.Length)`r`nConnection: close`r`nCache-Control: no-cache`r`n`r`n"
    $hb = $enc.GetBytes($head)
    $stream.Write($hb, 0, $hb.Length)
    $stream.Write($body, 0, $body.Length)
    $stream.Flush()
  } catch { } finally { $client.Close() }
}
