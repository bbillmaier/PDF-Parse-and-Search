$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $projectRoot "artifacts"
$archivePath = Join-Path $artifactDir "pdf-to-html-demo-images.tar"

New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null

Push-Location $projectRoot
try {
    docker compose build api web
    docker pull postgres:17-alpine
    docker save --output $archivePath pdf-to-html-api:demo pdf-to-html-web:demo postgres:17-alpine
} finally {
    Pop-Location
}

Write-Host "Demo images exported to $archivePath"
Write-Host "On the other machine: docker load --input .\artifacts\pdf-to-html-demo-images.tar"
