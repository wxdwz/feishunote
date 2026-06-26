import * as vscode from 'vscode';
import { marked } from 'marked';

interface DocPreviewState {
    isLoggedIn: boolean;
    isLoading: boolean;
    docContent?: string;
    docTitle?: string;
    errorMessage?: string;
    documentList?: Array<{
        token: string;
        title: string;
        type: string;
        url: string;
        ownerName?: string;
        updateTime?: number;
    }>;
}

export class DocPreviewViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'feishunote.docPreview';

    private view?: vscode.WebviewView;
    private state: DocPreviewState = {
        isLoggedIn: false,
        isLoading: false,
    };
    private scriptUri: string = '';
    private onAction: (action: { type: string; url?: string; docToken?: string; title?: string; docType?: string }) => void;

    constructor(
        private context: vscode.ExtensionContext,
        onAction: (action: { type: string; url?: string; docToken?: string; title?: string; docType?: string }) => void
    ) {
        this.onAction = onAction;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        const scriptUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'webview.js')
        );

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };

        webviewView.webview.onDidReceiveMessage((message: { type: string; url?: string; docToken?: string; title?: string; docType?: string }) => {
            this.onAction(message);
        });

        this.scriptUri = scriptUri.toString();
        this.updateHtml();
        // 通知扩展端同步登录态
        this.onAction({ type: 'syncState' });
    }

    setLoggedIn(isLoggedIn: boolean): void {
        this.state.isLoggedIn = isLoggedIn;
        this.state.isLoading = false;
        this.updateHtml();
    }

    setDocumentList(documents: Array<{
        token: string;
        title: string;
        type: string;
        url: string;
        ownerName?: string;
        updateTime?: number;
    }>): void {
        this.state.documentList = documents;
        this.state.isLoading = false;
        this.updateHtml();
    }

    setLoading(isLoading: boolean): void {
        this.state.isLoading = isLoading;
        this.updateHtml();
    }

    updateContent(markdown: string, title?: string): void {
        this.state.docContent = markdown;
        this.state.docTitle = title;
        this.state.isLoading = false;
        this.state.errorMessage = undefined;
        this.updateHtml();
    }

    showError(message: string): void {
        this.state.errorMessage = message;
        this.state.isLoading = false;
        this.updateHtml();
    }

    clear(): void {
        this.state.docContent = undefined;
        this.state.docTitle = undefined;
        this.state.errorMessage = undefined;
        this.updateHtml();
    }

    private updateHtml(): void {
        if (!this.view) { return; }
        if (this.state.isLoading) {
            this.view.webview.html = this.getLoadingHtml();
        } else if (this.state.docContent) {
            this.view.webview.html = this.getDocHtml();
        } else if (this.state.isLoggedIn) {
            this.view.webview.html = this.getHomeHtml();
        } else {
            this.view.webview.html = this.getLoginHtml();
        }
    }

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    private getLoginHtml(): string {
        const err = this.state.errorMessage
            ? `<div class="err">${this.esc(this.state.errorMessage)}</div>` : '';
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>${this.getCommonCss()}</style>
<script src="${this.scriptUri}" defer></script>
</head>
<body>
<div class="center">
  <div class="card">
    <h2>飞书文档</h2>
    <p class="sub">在 VSCode 中查看飞书文档</p>
    ${err}
    <button class="btn-p" data-action="login">飞书登录</button>
    <p class="hint">点击后将跳转浏览器完成授权</p>
  </div>
</div>
</body></html>`;
    }

    private getHomeHtml(): string {
        const err = this.state.errorMessage
            ? `<div class="err">${this.esc(this.state.errorMessage)}</div>` : '';

        let docListHtml = '';
        if (this.state.documentList && this.state.documentList.length > 0) {
            const items = this.state.documentList.map(doc => {
                const timeStr = doc.updateTime
                    ? new Date(doc.updateTime * 1000).toLocaleDateString('zh-CN')
                    : '';
                return `<div class="doc-item" data-token="${this.esc(doc.token)}" data-type="${this.esc(doc.type)}">
                    <div class="doc-item-content">
                        <div class="doc-title">${this.esc(doc.title)}</div>
                        <div class="doc-meta">${timeStr ? `更新于 ${timeStr}` : ''}</div>
                    </div>
                    <button class="btn-delete" data-token="${this.esc(doc.token)}" data-type="${this.esc(doc.type)}" title="删除">删除</button>
                </div>`;
            }).join('');
            docListHtml = `<div class="doc-list">${items}</div>`;
        } else {
            docListHtml = '<p class="hint" style="text-align:center;margin:20px 0">暂无文档</p>';
        }

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>${this.getCommonCss()}
.doc-list{display:flex;flex-direction:column;gap:8px;margin:12px 0 16px;max-height:calc(100vh - 220px);overflow-y:auto}
.doc-item{display:flex;align-items:center;padding:10px 12px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:4px;transition:background .15s}
.doc-item:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}
.doc-item-content{flex:1;cursor:pointer;min-width:0}
.doc-title{font-size:13px;font-weight:500;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc-meta{font-size:11px;color:var(--vscode-descriptionForeground)}
.btn-delete{background:transparent;color:var(--vscode-descriptionForeground);padding:4px 8px;font-size:12px;border-radius:3px;margin-left:8px;opacity:0.6}
.btn-delete:hover{opacity:1;background:var(--vscode-button-secondaryHoverBackground,#45494e)}
.header-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.header-row h2{margin:0}
.header-actions{display:flex;gap:8px}
</style>
<script src="${this.scriptUri}" defer></script>
</head>
<body>
<div class="pad">
  <div class="bar"><span class="dot"></span> 已登录</div>
  <div class="header-row">
    <h2>我的文档</h2>
    <div class="header-actions">
      <button class="btn-s" data-action="showCreateDialog">新建文档</button>
      <button class="btn-s" data-action="refreshList">刷新列表</button>
      <button class="btn-s" data-action="logout">退出</button>
    </div>
  </div>
  ${err}
  ${docListHtml}
</div>
</body></html>`;
    }

    private getDocHtml(): string {
        const title = this.esc(this.state.docTitle || '飞书文档');
        const body = marked.parse(this.state.docContent || '');
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<script src="${this.scriptUri}" defer></script>
<style>
${this.getCommonCss()}
.doc{display:flex;flex-direction:column;height:100vh}
.hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border,#e0e0e0);flex-shrink:0}
.hdr-t{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px}
.hdr-a{display:flex;gap:4px}
.md{flex:1;overflow-y:auto;padding:14px 16px 40px;line-height:1.7}
.md h1{font-size:1.5em;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:4px;margin:20px 0 10px}
.md h2{font-size:1.25em;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:3px;margin:16px 0 8px}
.md h3{font-size:1.1em;margin:12px 0 6px}
.md p{margin:6px 0}
.md pre{background:var(--vscode-textCodeBlock-background,#f6f8fa);padding:12px;border-radius:4px;overflow-x:auto}
.md code{font-family:var(--vscode-editor-font-family,monospace);font-size:0.9em}
.md pre code{background:none;padding:0}
.md blockquote{padding:4px 10px;border-left:3px solid var(--vscode-textBlockQuote-border,#007acc);margin:8px 0;color:var(--vscode-descriptionForeground)}
.md ul,.md ol{padding-left:20px;margin:6px 0}
.md table{border-collapse:collapse;width:100%;margin:10px 0}
.md th,.md td{padding:6px 10px;border:1px solid var(--vscode-panel-border);text-align:left}
.md th{font-weight:600}
</style>
</head>
<body>
<div class="doc">
  <div class="hdr">
    <span class="hdr-t">${title}</span>
    <span class="hdr-a">
      <button class="btn-s" data-action="openInEditor">编辑</button>
      <button class="btn-s" data-action="refresh">刷新</button>
      <button class="btn-s" data-action="goHome">返回</button>
    </span>
  </div>
  <div class="md">${body}</div>
</div>
</body></html>`;
    }

    private getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
${this.getCommonCss()}
.c{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;color:var(--vscode-descriptionForeground)}
.s{width:28px;height:28px;border:3px solid var(--vscode-panel-border,#e0e0e0);border-top-color:var(--vscode-focusBorder,#007acc);border-radius:50%;animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="c"><div class="s"></div><p style="font-size:13px">正在加载...</p></div>
</body></html>`;
    }

    private getCommonCss(): string {
        return `*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:var(--vscode-font-family,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-size:13px}
button{font-family:inherit;cursor:pointer;border:none;border-radius:3px;padding:6px 12px;font-size:13px;transition:background .15s}
input{font-family:inherit;font-size:13px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border,#3c3c3c));background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);padding:6px 8px;border-radius:3px;outline:none;width:100%}
input:focus{border-color:var(--vscode-focusBorder,#007acc)}
h2{font-size:16px;font-weight:600;margin:0 0 8px}
.center{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.card{width:100%;max-width:280px;text-align:center;padding:20px 16px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:6px;background:var(--vscode-editor-background,transparent)}
.emoji{font-size:32px;margin-bottom:8px}
.sub{font-size:12px;color:var(--vscode-descriptionForeground);margin:4px 0 14px}
.hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:10px}
.pad{padding:14px}
.bar{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px}
.dot{width:7px;height:7px;border-radius:50%;background:#3fb950;display:inline-block}
.stack{display:flex;flex-direction:column;gap:8px;margin:10px 0 14px}
.btn-p{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);width:100%;padding:8px 12px}
.btn-p:hover{background:var(--vscode-button-hoverBackground,#1177bb)}
.btn-s{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);padding:5px 10px;font-size:12px}
.btn-s:hover{background:var(--vscode-button-secondaryHoverBackground,#45494e)}
.err{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);border:1px solid var(--vscode-inputValidation-errorBorder,#be1100);color:var(--vscode-errorForeground,#f48771);padding:6px 10px;border-radius:3px;font-size:12px;margin:8px 0;text-align:left}`;
    }
}
