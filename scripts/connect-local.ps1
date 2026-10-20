$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..
$settings = @{}
Get-Content .env | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { $settings[$matches[1]] = $matches[2] }
}
$headers = @{ Authorization = "Bearer $($settings.ADMIN_TOKEN)" }
$ready = Invoke-RestMethod 'http://localhost:8090/health/ready' -TimeoutSec 10
if ($ready.status -ne 'ready') { throw 'Motor ainda nao esta pronto.' }
$connections = @(Invoke-RestMethod 'http://localhost:8090/v1/connections' -Headers $headers)
$connection = $connections | Where-Object { $_.instance_name -eq $settings.EVOLUTION_INSTANCE } | Select-Object -First 1
if (-not $connection) { throw 'Conexao inicial nao encontrada.' }
$null = Invoke-RestMethod "http://localhost:8090/v1/connections/$($connection.id)/webhook" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
$result = Invoke-RestMethod "http://localhost:8090/v1/connections/$($connection.id)/sync-runs" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
[pscustomobject]@{ Webhook = 'configurado'; SyncRun = $result.runId; Api = 'http://localhost:8090'; Instance = $connection.instance_name } | ConvertTo-Json
