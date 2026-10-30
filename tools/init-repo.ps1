# 一键把当前目录初始化成 git 仓库（不联网、不推送）
# 用法：在 chrome-translator 目录里执行
#   powershell -ExecutionPolicy Bypass -File tools/init-repo.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "✖ 还没装 Git。先运行：winget install --id Git.Git -e" -ForegroundColor Red
  Write-Host "  装完关掉重开 PowerShell，再跑一次这个脚本。" -ForegroundColor Yellow
  exit 1
}

if (Test-Path .git) {
  Write-Host "· 已经是 git 仓库了，跳过 init" -ForegroundColor Yellow
} else {
  git init -b main | Out-Null
  Write-Host "✓ 初始化仓库（分支 main）" -ForegroundColor Green
}

git add .

# 安全检查：绝对不能把密钥加进去
$staged = git diff --cached --name-only
$bad = $staged | Where-Object { $_ -match '(^|/)(key\.local\.json|keys/)|\.(pem|key)$' }
if ($bad) {
  Write-Host "✖ 发现疑似密钥文件被加入了暂存区：" -ForegroundColor Red
  $bad | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
  Write-Host "  已自动撤下，请检查 .gitignore" -ForegroundColor Yellow
  $bad | ForEach-Object { git reset -q -- $_ }
}

$count = (git diff --cached --name-only | Measure-Object).Count
if ($count -eq 0) {
  Write-Host "· 没有要提交的改动" -ForegroundColor Yellow
} else {
  git commit -m "chore: 初始化鲸译扩展" | Out-Null
  Write-Host "✓ 已提交 $count 个文件" -ForegroundColor Green
}

Write-Host ""
Write-Host "接下来（在 GitHub 网页上）：" -ForegroundColor Cyan
Write-Host "  1. 打开 https://github.com/new"
Write-Host "  2. 仓库名填 whale-translator，选 Public，不要勾 README/.gitignore/License"
Write-Host "  3. 创建后复制仓库地址，回到这里执行："
Write-Host "       git remote add origin https://github.com/<你的用户名>/whale-translator.git"
Write-Host "       git push -u origin main"
Write-Host ""
Write-Host "第一次 push 会弹出浏览器登录 GitHub，授权一次即可。" -ForegroundColor Yellow
