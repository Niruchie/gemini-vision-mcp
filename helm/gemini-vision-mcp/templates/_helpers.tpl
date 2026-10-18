{{- define "gemini-vision-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "gemini-vision-mcp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "gemini-vision-mcp.labels" -}}
helm.sh/chart: {{ include "gemini-vision-mcp.chart" . }}
{{ include "gemini-vision-mcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "gemini-vision-mcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "gemini-vision-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gemini-vision-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the Secret holding GOOGLE_API_KEY.
*/}}
{{- define "gemini-vision-mcp.apiSecretName" -}}
{{- if .Values.apiKey.existingSecret }}
{{- .Values.apiKey.existingSecret }}
{{- else }}
{{- include "gemini-vision-mcp.fullname" . }}
{{- end }}
{{- end }}

{{/*
Name of the Secret holding MCP_AUTH_TOKEN.
*/}}
{{- define "gemini-vision-mcp.authSecretName" -}}
{{- if .Values.authToken.existingSecret }}
{{- .Values.authToken.existingSecret }}
{{- else }}
{{- include "gemini-vision-mcp.fullname" . }}
{{- end }}
{{- end }}

{{/*
Host header hostnames allowed to reach the service: its own DNS names plus any
extra ones requested via `allowedHosts`.
*/}}
{{- define "gemini-vision-mcp.allowedHosts" -}}
{{- $fullname := include "gemini-vision-mcp.fullname" . -}}
{{- $ns := .Release.Namespace -}}
{{- $defaults := list $fullname (printf "%s.%s" $fullname $ns) (printf "%s.%s.svc" $fullname $ns) (printf "%s.%s.svc.cluster.local" $fullname $ns) -}}
{{- join "," (concat $defaults (default (list) .Values.allowedHosts)) -}}
{{- end }}

