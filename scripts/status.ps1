$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..
$token = ((Get-Content .env | Where-Object { $_ -like 'ADMIN_TOKEN=*' }) -split '=', 2)[1]
Invoke-RestMethod 'http://localhost:8090/v1/status' -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 8
