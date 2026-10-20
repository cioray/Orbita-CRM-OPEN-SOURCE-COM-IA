$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$line = Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^ADMIN_TOKEN=' }
$token = $line -replace '^ADMIN_TOKEN=', ''
$link = Invoke-RestMethod 'http://localhost:8090/v1/workspace/access-link' -Method Post -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body '{}'
Start-Process ('http://localhost:8090' + $link.path)
