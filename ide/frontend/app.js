// IDE State
let editor = null;
var pyodideInstance = null;
let isPythonReady = false;
let currentFile = 'demo.py';
let activeRacecar = null;

let defaultFiles = {
    'demo.py': `import racecar_core
import racecar_utils as rc_utils

rc = racecar_core.create_racecar()

# Global variables
speed = 0.0
angle = 0.0

def start():
    global speed, angle
    speed = 0.5
    angle = 0.0
    print("Kinematics testing environment initialized. Speed target set to 0.5.")

def update():
    global speed, angle
    # Apply motion commands to the physical model
    rc.drive.set_speed_angle(speed, angle)
    
    # Analyze LiDAR sensor array data (360 sample points)
    samples = rc.lidar.get_samples()
    if samples[0] < 1.0: # obstacle detected in trajectory path
        rc.drive.stop()
        print("Proximity boundary reached. Halting dynamic model.")

rc.set_start_update(start, update)
rc.go()
`
};

var files;
try {
    const savedFiles = localStorage.getItem('racecar_files');
    files = savedFiles ? JSON.parse(savedFiles) : defaultFiles;
} catch (e) {
    files = defaultFiles;
}

let autoSaveMode = localStorage.getItem('autosave-mode') || 'auto';
let hasUnsavedChanges = false;
let hasUnexportedData = false;
let warnExportToggleVal = localStorage.getItem('warn-export') !== 'false'; // true by default

function updateTabsUI() {
    if (currentFile) {
        editorTabsEl.innerHTML = `<div class="tab active">${currentFile}${hasUnsavedChanges ? ' *' : ''}</div>`;
    } else {
        editorTabsEl.innerHTML = '';
    }
}

// DOM Elements
const terminalEl = document.getElementById('terminal');

// --- Terminal Output Helper ---
// Routes ALL informational / warning / error messages to the terminal pane
// so nothing is hidden behind popups or transient banners.
function terminalMsg(message, level) {
    if (!terminalEl) return;
    level = level || 'info';
    var prefix = '';
    if (level === 'error') prefix = '[ERROR] ';
    else if (level === 'warn') prefix = '[WARNING] ';
    else if (level === 'success') prefix = '[OK] ';
    terminalEl.textContent += prefix + message + '\n';
    terminalEl.scrollTop = terminalEl.scrollHeight;
}
// Expose for index.html inline-script use
window.terminalMsg = terminalMsg;

const runBtn = document.getElementById('run-btn');
const chooseRunBtn = document.getElementById('choose-run-btn');
const stopBtn = document.getElementById('stop-run-btn');
const statusBadge = document.getElementById('pyodide-status');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings');
const themeBtns = document.querySelectorAll('.theme-btn');
const fileListEl = document.getElementById('file-list');
const newFileBtn = document.getElementById('new-file-btn');
const uploadBtn = document.getElementById('upload-btn');
const downloadBtn = document.getElementById('download-btn');
const folderInput = document.getElementById('folder-input');
const editorTabsEl = document.getElementById('editor-tabs');

// --- 1. File & Workspace Management ---
let expandedFolders = {};
try {
    const savedExpanded = localStorage.getItem('racecar_expanded_folders');
    expandedFolders = savedExpanded ? JSON.parse(savedExpanded) : {};
} catch (e) {
    expandedFolders = {};
}

function saveExpandedFolders() {
    try {
        localStorage.setItem('racecar_expanded_folders', JSON.stringify(expandedFolders));
    } catch (e) {
        console.warn("Could not save expanded folders to localStorage:", e);
    }
}

let selectedContextFile = null;
const fileContextMenu = document.getElementById('file-context-menu');
const fileCtxCreateNested = document.getElementById('file-ctx-create-nested');
const fileCtxRename = document.getElementById('file-ctx-rename');
const fileCtxDelete = document.getElementById('file-ctx-delete');

if (fileCtxCreateNested) {
    fileCtxCreateNested.addEventListener('click', (e) => {
        e.stopPropagation();
        if (fileContextMenu) fileContextMenu.classList.add('hidden');
        if (selectedContextFile && selectedContextFile.endsWith('/')) {
            const folder = selectedContextFile;
            setTimeout(() => createItemPrompt(folder), 50);
        }
    });
}

if (fileCtxRename) {
    fileCtxRename.addEventListener('click', (e) => {
        e.stopPropagation();
        if (fileContextMenu) fileContextMenu.classList.add('hidden');
        if (selectedContextFile) {
            const target = selectedContextFile;
            setTimeout(() => renameFileOrFolder(target), 50);
        }
    });
}

if (fileCtxDelete) {
    fileCtxDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        if (fileContextMenu) fileContextMenu.classList.add('hidden');
        if (selectedContextFile) {
            const target = selectedContextFile;
            setTimeout(() => deleteFileOrFolder(target), 50);
        }
    });
}

document.addEventListener('click', () => {
    if (fileContextMenu) fileContextMenu.classList.add('hidden');
});


// --- Global Fix: Neutralize Unity WebGL Keyboard Hijacking ---
const neutralizeUnityPreventDefault = (e) => {
    const target = e.target;
    if (!target) return;

    // Monaco editor uses an internal <textarea> for input.  Unity's keyboard
    // hijack normally calls preventDefault() on key events, which would block
    // typing into any <input>/<textarea>.  We neutralize preventDefault for
    // real user-facing input elements so Unity can't swallow their keystrokes.
    //
    // BUT: Monaco itself also calls preventDefault() to suppress the browser's
    // native textarea behaviour after it has already handled the keystroke
    // internally.  If we replace preventDefault with a no-op on Monaco's
    // textarea, the browser's native handler ALSO fires, so one Backspace press
    // deletes two characters (Monaco deletes one, the browser deletes another).
    //
    // The solution:
    // - For standard <input> elements inside #editor (e.g., Monaco's Find
    //   widget, which are actual INPUT tags): neutralize ALL event types so
    //   both character typing (keypress) and backspace/delete (keydown) work.
    // - For Monaco's own internal <textarea>: only neutralize keypress, because
    //   Monaco itself calls preventDefault() on keydown (e.g., for Backspace)
    //   to suppress the browser's native textarea handler. Replacing it with a
    //   no-op causes double-character deletion.
    if (target.closest && target.closest('#editor')) {
        const isStandardInput = target.tagName === 'INPUT';
        if (isStandardInput || e.type === 'keypress') {
            e.preventDefault = () => { };
        }
        return;
    }

    const isInput = target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable ||
        (target.closest && target.closest('#custom-dialog-overlay'));

    if (isInput) {
        // Neutralize preventDefault so Unity WebGL cannot block browser text input
        e.preventDefault = () => { };
    }
};

window.addEventListener('keydown', neutralizeUnityPreventDefault, true);
window.addEventListener('keypress', neutralizeUnityPreventDefault, true);
window.addEventListener('keyup', neutralizeUnityPreventDefault, true);

// --- Custom Dialog Utility ---
const CustomDialog = {
    overlay: document.getElementById('custom-dialog-overlay'),
    titleEl: document.getElementById('custom-dialog-title'),
    msgEl: document.getElementById('custom-dialog-message'),
    inputEl: document.getElementById('custom-dialog-input'),
    selectEl: document.getElementById('custom-dialog-select'),
    btnCancel: document.getElementById('custom-dialog-cancel'),
    btnOk: document.getElementById('custom-dialog-ok'),

    _show(title, message, type, optionsOrValue = '') {
        return new Promise(resolve => {
            this.titleEl.textContent = title;
            this.msgEl.textContent = message;

            if (type === 'prompt') {
                this.inputEl.style.display = 'block';
                if (this.selectEl) this.selectEl.style.display = 'none';
                this.inputEl.value = optionsOrValue;
            } else if (type === 'choice') {
                this.inputEl.style.display = 'none';
                if (this.selectEl) {
                    this.selectEl.style.display = 'block';
                    this.selectEl.innerHTML = '';
                    const { options, defaultValue } = optionsOrValue;
                    options.forEach(opt => {
                        const optionEl = document.createElement('option');
                        optionEl.value = opt.value || opt;
                        optionEl.textContent = opt.label || opt;
                        if (optionEl.value === defaultValue) optionEl.selected = true;
                        this.selectEl.appendChild(optionEl);
                    });
                }
            } else {
                this.inputEl.style.display = 'none';
                if (this.selectEl) this.selectEl.style.display = 'none';
            }

            if (type === 'alert') {
                this.btnCancel.style.display = 'none';
            } else {
                this.btnCancel.style.display = 'block';
            }

            this.overlay.classList.remove('hidden');
            if (type === 'prompt') {
                setTimeout(() => {
                    this.inputEl.focus();
                    this.inputEl.select();
                }, 50);
            } else if (type === 'choice' && this.selectEl) {
                setTimeout(() => {
                    this.selectEl.focus();
                }, 50);
            }

            const cleanup = () => {
                this.overlay.classList.add('hidden');
                this.btnOk.onclick = null;
                this.btnCancel.onclick = null;
                this.inputEl.onkeydown = null;
                this.inputEl.onkeypress = null;
                this.inputEl.onkeyup = null;
                if (this.selectEl) {
                    this.selectEl.onkeydown = null;
                    this.selectEl.onkeypress = null;
                    this.selectEl.onkeyup = null;
                }
                document.removeEventListener('keydown', handleEscape);
            };

            const handleOk = () => {
                cleanup();
                if (type === 'prompt') resolve(this.inputEl.value);
                else if (type === 'choice') resolve(this.selectEl ? this.selectEl.value : null);
                else resolve(true);
            };

            const handleCancel = () => {
                cleanup();
                if (type === 'prompt' || type === 'choice') resolve(null);
                else resolve(false);
            };

            const handleEscape = (e) => {
                if (e.key === 'Escape') handleCancel();
                if (e.key === 'Enter' && type !== 'prompt' && type !== 'choice') handleOk();
            };

            this.btnOk.onclick = handleOk;
            this.btnCancel.onclick = handleCancel;

            const preventUnity = (e) => e.stopPropagation();
            this.inputEl.onkeyup = preventUnity;
            this.inputEl.onkeypress = preventUnity;
            this.inputEl.onkeydown = (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') handleOk();
                if (e.key === 'Escape') handleCancel();
            };
            if (this.selectEl) {
                this.selectEl.onkeyup = preventUnity;
                this.selectEl.onkeypress = preventUnity;
                this.selectEl.onkeydown = (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') handleOk();
                    if (e.key === 'Escape') handleCancel();
                };
            }
            document.addEventListener('keydown', handleEscape);
        });
    },

    prompt(message, defaultValue = '') {
        return this._show('Input Required', message, 'prompt', defaultValue);
    },
    choice(message, options, defaultValue = '') {
        return this._show('Input Required', message, 'choice', { options, defaultValue });
    },
    alert(message) {
        return this._show('Notice', message, 'alert');
    },
    confirm(message) {
        return this._show('Confirm Action', message, 'confirm');
    }
};

async function createItemPrompt(parentFolder = '') {
    const targetParent = parentFolder ? (parentFolder.endsWith('/') ? parentFolder : parentFolder + '/') : '';
    const locationName = targetParent ? `inside '${targetParent.slice(0, -1)}'` : 'at workspace root';
    const choice = await CustomDialog.choice(
        `Create New Workspace Item ${locationName}:`,
        [{ value: 'file', label: 'New File' }, { value: 'folder', label: 'New Folder' }],
        'file'
    );
    if (!choice) return;

    if (choice === 'file') {
        const filename = await CustomDialog.prompt(`Enter new filename (e.g. script.py, data.txt):`);
        if (filename) {
            let name = filename.trim();
            if (name.includes('/')) {
                terminalMsg("File names cannot contain '/'. Create folders separately.", "error");
                return;
            }
            if (!name.includes('.')) {
                name += '.py';
            } else {
                const ext = name.split('.').pop().toLowerCase();
                const allowedExts = ['py', 'js', 'txt', 'html', 'css', 'json', 'md', 'csv', 'xml', 'yml', 'yaml', 'sh', 'cpp', 'c', 'h', 'hpp', 'java'];
                if (!allowedExts.includes(ext)) {
                    terminalMsg("Invalid file extension. Allowed: .py, .js, .txt, .html, .css, .json, .md, .csv, .xml, .yml, .yaml, .sh, .cpp, .c, .h, .hpp, .java", "error");
                    return;
                }
            }
            const fullPath = targetParent + name;
            if (Object.prototype.hasOwnProperty.call(files, fullPath)) {
                terminalMsg('File already exists.', "error");
                return;
            }
            saveCurrentFile();
            files[fullPath] = name.endsWith('.py') ? `# ${fullPath}\nimport racecar_core\nimport racecar_utils as rc_utils\n` : '';
            currentFile = fullPath;
            if (targetParent) expandedFolders[targetParent] = true;
            saveExpandedFolders();
            loadActiveFile();
            saveCurrentFile(true);
            updateFileTree();
        }
    } else if (choice === 'folder') {
        const folderName = await CustomDialog.prompt(`Enter new folder name:`);
        if (folderName) {
            let name = folderName.trim();
            if (name.includes('/')) {
                terminalMsg("Folder names cannot contain '/'. Create each folder separately.", "error");
                return;
            }
            if (!name.endsWith('/')) name += '/';
            const fullPath = targetParent + name;
            if (Object.prototype.hasOwnProperty.call(files, fullPath)) {
                terminalMsg('Folder already exists.', "error");
                return;
            }
            files[fullPath] = '';
            if (targetParent) expandedFolders[targetParent] = true;
            expandedFolders[fullPath] = true;
            saveExpandedFolders();
            saveCurrentFile(true);
            updateFileTree();
        }
    }
}

async function renameFileOrFolder(oldPath) {
    if (!oldPath) return;
    const isFolder = oldPath.endsWith('/');
    const parts = isFolder ? oldPath.slice(0, -1).split('/') : oldPath.split('/');
    const baseName = parts[parts.length - 1];
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';

    const newName = await CustomDialog.prompt(`Enter new name for '${baseName}':`, baseName);
    if (!newName) return;
    const cleanName = newName.trim();
    if (!cleanName || cleanName === baseName) return;

    if (isFolder) {
        const newFolderPath = parentPath + (cleanName.endsWith('/') ? cleanName : cleanName + '/');
        if (Object.prototype.hasOwnProperty.call(files, newFolderPath) && newFolderPath !== oldPath) {
            terminalMsg(`A folder named '${cleanName}' already exists.`, "error");
            return;
        }
        const keysToRename = Object.keys(files).filter(k => k === oldPath || k.startsWith(oldPath));
        keysToRename.forEach(k => {
            const relPath = k.slice(oldPath.length);
            const targetKey = newFolderPath + relPath;
            files[targetKey] = files[k];
            delete files[k];
        });
        // Migrate collapse state for the folder AND all nested subfolders, so a
        // rename doesn't orphan expandedFolders keys under the old path.
        Object.keys(expandedFolders).forEach(k => {
            if (k === oldPath || k.startsWith(oldPath)) {
                expandedFolders[newFolderPath + k.slice(oldPath.length)] = expandedFolders[k];
                delete expandedFolders[k];
            }
        });
        saveExpandedFolders();
        if (currentFile.startsWith(oldPath)) {
            currentFile = newFolderPath + currentFile.slice(oldPath.length);
        }
    } else {
        let finalFileName = cleanName;
        if (!finalFileName.includes('.')) finalFileName += '.py';
        else {
            const ext = finalFileName.split('.').pop().toLowerCase();
            const allowedExts = ['py', 'js', 'txt', 'html', 'css', 'json', 'md', 'csv', 'xml', 'yml', 'yaml', 'sh', 'cpp', 'c', 'h', 'hpp', 'java'];
            if (!allowedExts.includes(ext)) {
                terminalMsg("Invalid file extension. Allowed: .py, .js, .txt, .html, .css, .json, .md, .csv, .xml, .yml, .yaml, .sh, .cpp, .c, .h, .hpp, .java", "error");
                return;
            }
        }
        const targetFile = parentPath + finalFileName;
        if (Object.prototype.hasOwnProperty.call(files, targetFile) && targetFile !== oldPath) {
            terminalMsg(`A file named '${finalFileName}' already exists.`, "error");
            return;
        }
        files[targetFile] = files[oldPath];
        delete files[oldPath];
        if (currentFile === oldPath) {
            currentFile = targetFile;
        }
    }
    saveCurrentFile(true);
    updateFileTree();
    loadActiveFile();
}

async function deleteFileOrFolder(targetPath) {
    if (!targetPath) return;
    const isFolder = targetPath.endsWith('/');
    const typeName = isFolder ? 'folder' : 'file';
    const confirmed = await CustomDialog.confirm(`Are you sure you want to delete the ${typeName} '${targetPath}'?\n\nThis action cannot be undone.`);
    if (!confirmed) return;

    if (isFolder) {
        const keysToDelete = Object.keys(files).filter(k => k === targetPath || k.startsWith(targetPath));
        keysToDelete.forEach(k => delete files[k]);
        delete expandedFolders[targetPath];
        saveExpandedFolders();
        if (currentFile.startsWith(targetPath)) {
            const remainingFiles = Object.keys(files).filter(k => !k.endsWith('/'));
            if (remainingFiles.length > 0) {
                currentFile = remainingFiles[0];
            } else {
                files['demo.py'] = `# demo.py\nimport racecar_core\nimport racecar_utils as rc_utils\n`;
                currentFile = 'demo.py';
            }
        }
    } else {
        delete files[targetPath];
        if (currentFile === targetPath) {
            const remainingFiles = Object.keys(files).filter(k => !k.endsWith('/'));
            if (remainingFiles.length > 0) {
                currentFile = remainingFiles[0];
            } else {
                files['demo.py'] = `# demo.py\nimport racecar_core\nimport racecar_utils as rc_utils\n`;
                currentFile = 'demo.py';
            }
        }
    }
    // Load the replacement file into the editor BEFORE saving, so the deleted
    // file's stale editor content is never written into the replacement file.
    updateFileTree();
    loadActiveFile();
    saveCurrentFile(true);
}

function updateFileTree() {
    fileListEl.innerHTML = '';
    const keys = Object.keys(files);

    const items = [];
    keys.forEach(path => {
        const parts = path.endsWith('/') ? path.slice(0, -1).split('/') : path.split('/');
        const isFolder = path.endsWith('/');
        const depth = parts.length - 1;

        let isVisible = true;
        let currentAncestor = '';
        for (let i = 0; i < parts.length - 1; i++) {
            currentAncestor += parts[i] + '/';
            if (expandedFolders[currentAncestor] === false) {
                isVisible = false;
                break;
            }
        }

        if (isVisible) {
            items.push({
                path,
                displayName: parts[parts.length - 1],
                isFolder,
                depth
            });
        }
    });

    items.sort((a, b) => {
        const aFolder = a.isFolder ? 0 : 1;
        const bFolder = b.isFolder ? 0 : 1;
        if (aFolder !== bFolder) return aFolder - bFolder;
        return a.path.localeCompare(b.path);
    });

    items.forEach(item => {
        const li = document.createElement('li');
        const depthClass = `depth-${Math.min(item.depth, 3)}`;
        li.className = `file-item ${item.isFolder ? 'folder-item' : ''} ${item.path === currentFile ? 'active' : ''} ${depthClass}`;

        if (item.isFolder) {
            const isExpanded = expandedFolders[item.path] !== false;
            li.innerHTML = `
                <span class="folder-toggle" title="Toggle Folder">${isExpanded ? '▼' : '▶'}</span>
                <span>📁 ${item.displayName}</span>
            `;

            li.addEventListener('click', () => {
                expandedFolders[item.path] = !isExpanded;
                saveExpandedFolders();
                updateFileTree();
            });
        } else {
            li.innerHTML = `
                <span style="width: 14px; margin-right: 2px;"></span>
                <span>📝 ${item.displayName}</span>
            `;

            li.addEventListener('click', () => {
                saveCurrentFile();
                currentFile = item.path;
                updateFileTree();
                loadActiveFile();
            });
        }

        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectedContextFile = item.path;
            if (fileCtxCreateNested) {
                fileCtxCreateNested.style.display = item.isFolder ? 'flex' : 'none';
            }
            if (fileContextMenu) {
                const x = Math.min(e.clientX, window.innerWidth - 200);
                const y = Math.min(e.clientY, window.innerHeight - 140);
                fileContextMenu.style.left = `${Math.max(10, x)}px`;
                fileContextMenu.style.top = `${Math.max(10, y)}px`;
                fileContextMenu.classList.remove('hidden');
            }
        });

        fileListEl.appendChild(li);
    });

    updateTabsUI();
}

function saveCurrentFile(force = false) {
    if (editor && currentFile) {
        files[currentFile] = editor.getValue();
        if (autoSaveMode === 'auto' || force) {
            try {
                localStorage.setItem('racecar_files', JSON.stringify(files));
                hasUnsavedChanges = false;
                hasUnexportedData = true;
                updateTabsUI();
            } catch (e) {
                console.error("LocalStorage save error:", e);
                terminalMsg("Storage Limit Reached: Could not auto-save files to local browser storage. Please export your project.", "error");
            }
        }
    }
}

function loadActiveFile() {
    if (editor && currentFile) {
        editor.setValue(files[currentFile] || '');
        hasUnsavedChanges = false;
        updateTabsUI();
    }
}

newFileBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setTimeout(() => createItemPrompt(''), 50);
});

// Upload Folder (Optional)
if (uploadBtn && folderInput) {
    uploadBtn.addEventListener('click', () => folderInput.click());
    folderInput.addEventListener('change', async (e) => {
        const uploadedFiles = e.target.files;
        if (uploadedFiles.length === 0) return;

        saveCurrentFile();
        let loadedAny = false;

        for (let i = 0; i < uploadedFiles.length; i++) {
            const file = uploadedFiles[i];
            if (file.name.endsWith('.py')) {
                const content = await file.text();
                files[file.name] = content;
                if (!loadedAny) {
                    currentFile = file.name;
                    loadedAny = true;
                }
            }
        }

        if (loadedAny) {
            updateFileTree();
            loadActiveFile();
            if (terminalEl) terminalEl.textContent += `Loaded ${uploadedFiles.length} files into workspace.\n`;
        }
    });
}

// Download Folder (Optional)
if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
        saveCurrentFile();
        const zip = new JSZip();
        Object.keys(files).forEach(filename => {
            zip.file(filename, files[filename]);
        });

        const content = await zip.generateAsync({ type: 'blob' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = 'racecar_workspace.zip';
        link.click();
    });
}

// --- 2. Monaco Editor Initialization & Fallback System ---
function setupFallbackEditor() {
    if (editor) return;
    const editorDiv = document.getElementById('editor');
    if (!editorDiv) return;

    let fallbackTextarea = document.getElementById('fallback-textarea');
    if (!fallbackTextarea) {
        fallbackTextarea = document.createElement('textarea');
        fallbackTextarea.id = 'fallback-textarea';
        fallbackTextarea.style.width = '100%';
        fallbackTextarea.style.height = '100%';
        fallbackTextarea.style.backgroundColor = '#1e1e1e';
        fallbackTextarea.style.color = '#d4d4d4';
        fallbackTextarea.style.fontFamily = "'JetBrains Mono', monospace";
        fallbackTextarea.style.fontSize = '14px';
        fallbackTextarea.style.border = 'none';
        fallbackTextarea.style.padding = '16px';
        fallbackTextarea.style.resize = 'none';
        fallbackTextarea.style.outline = 'none';

        editorDiv.innerHTML = '';
        editorDiv.appendChild(fallbackTextarea);
    }

    let listeners = [];
    fallbackTextarea.value = files[currentFile] || '';

    fallbackTextarea.addEventListener('input', () => {
        hasUnsavedChanges = true;
        updateTabsUI();
        if (autoSaveMode === 'auto') {
            saveCurrentFile();
        }
        listeners.forEach(cb => { try { cb(); } catch (e) { } });
    });

    editor = {
        getValue: () => fallbackTextarea.value,
        setValue: (val) => { fallbackTextarea.value = val; },
        onDidChangeModelContent: (cb) => { listeners.push(cb); },
        addCommand: () => { }
    };

    updateFileTree();
}

let monacoLoaded = false;

if (typeof require !== 'undefined') {
    try {
        require.config({
            paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' }
        });
        require(['vs/editor/editor.main'], function () {
            monacoLoaded = true;
            const editorDiv = document.getElementById('editor');
            // If the fallback editor activated first (Monaco finished loading
            // late), preserve any edits typed into it before replacing it.
            if (editor && editorDiv && editorDiv.querySelector('#fallback-textarea')) {
                files[currentFile] = editor.getValue();
            }
            if (editorDiv) editorDiv.innerHTML = '';
            editor = monaco.editor.create(editorDiv, {
                value: files[currentFile] || '',
                language: 'python',
                theme: 'vs-dark',
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 14,
                fontFamily: "'JetBrains Mono', monospace",
                padding: { top: 16 }
            });

            editor.onDidChangeModelContent(() => {
                hasUnsavedChanges = true;
                updateTabsUI();
                if (autoSaveMode === 'auto') {
                    saveCurrentFile();
                }
            });

            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                saveCurrentFile(true);
                terminalEl.textContent += `> Saved ${currentFile} manually.\n`;
                terminalEl.scrollTop = terminalEl.scrollHeight;
            });

            updateFileTree();
            if (typeof window.loadUnity === "function") {
                window.loadUnity();
            }
        }, function (err) {
            console.error("Monaco editor failed to load:", err);
            setupFallbackEditor();
        });
    } catch (e) {
        console.error("Monaco require error:", e);
        setupFallbackEditor();
    }
} else {
    setupFallbackEditor();
}

setTimeout(() => {
    if (!monacoLoaded && !editor) {
        console.warn("Monaco initialization timed out, activating fallback editor.");
        setupFallbackEditor();
    }
}, 3000);

// Defer Unity WebGL loading: the 74 MB frontend.data competes with
// Monaco (~10 MB from CDN) and Pyodide (~30 MB from CDN) for bandwidth.
// We start Unity only after Monaco finishes loading (line ~740), or when
// the user explicitly opens the Simulator window (taskbar click handler).
// This way the code editor is ready in a few seconds instead of waiting
// for a 74 MB download the user may not even need.

// --- 3. Pyodide Integration ---
async function initPyodide() {
    // Cross-origin isolation warning
    if (!window.crossOriginIsolated) {
        if (window.location.protocol === "file:") {
            terminalEl.textContent += "[WARNING] Page opened via file:// — Pyodide will work but the Unity simulator requires a web server.\n";
            terminalEl.textContent += "          Run: python -m http.server 8000  then open localhost:8000\n";
        } else {
            terminalEl.textContent += "[WARNING] Page is not cross-origin isolated. Unity WebGL simulator may fail to load correctly.\n";
            terminalEl.textContent += "          If running on GitHub Pages, verify that coi-serviceworker.js is loaded.\n";
        }
    }

    try {
        pyodideInstance = await loadPyodide({
            stdout: (text) => {
                terminalEl.textContent += text + "\n";
                terminalEl.scrollTop = terminalEl.scrollHeight;
            },
            stderr: (text) => {
                terminalEl.textContent += "[ERROR] " + text + "\n";
                terminalEl.scrollTop = terminalEl.scrollHeight;
            }
        });

        terminalEl.textContent += "Loading standard packages (numpy, opencv)... Please wait.\n";
        await pyodideInstance.loadPackage(['numpy', 'opencv-python']);

        // Download and write custom library modules with explicit error handling
        terminalEl.textContent += "Fetching racecar libraries...\n";

        let coreCode = "";
        let utilsCode = "";
        try {
            const coreResponse = await fetch('racecar_core.py?v=2.0.10');
            if (!coreResponse.ok) throw new Error("HTTP error");
            coreCode = await coreResponse.text();

            const utilsResponse = await fetch('racecar_utils.py?v=2.0.10');
            if (!utilsResponse.ok) throw new Error("HTTP error");
            utilsCode = await utilsResponse.text();
        } catch (e) {
            terminalEl.textContent += "Using embedded racecar libraries (local fallback)...\n";
            coreCode = `import js
import numpy as np
from enum import IntEnum
from pyodide.ffi import create_proxy

# Embedded fallback copy of racecar_core.py (used only if the fetch above
# fails, e.g. when opened over file://). Keep in sync with racecar_core.py.
# Sensor payloads are exposed as the property "data", NOT "to_py" (which
# collides with Pyodide's JsProxy.to_py() method).

def _js_to_python(raw):
    if raw is None:
        return None
    try:
        if hasattr(raw, "to_py"):
            return raw.to_py()
    except Exception:
        pass
    return raw

def _to_array(raw, dtype):
    py = _js_to_python(raw)
    if py is None:
        return None
    if isinstance(py, dict):
        py = list(py.values())
    try:
        arr = np.asarray(py, dtype=dtype)
    except Exception:
        try:
            arr = np.frombuffer(bytes(py), dtype=dtype)
        except Exception:
            return None
    if not arr.flags.writeable:
        arr = arr.copy()
    return arr

class Drive:
    def set_speed_angle(self, speed, angle):
        js.window.unitySetDrive(speed, angle)
    def stop(self):
        js.window.unityStopDrive()
    def set_max_speed(self, max_speed):
        js.window.unitySetMaxSpeed(max_speed)

class Lidar:
    def _samples(self):
        try:
            if not hasattr(js.window, "racecarState"): return None
            state = js.window.racecarState
            if not hasattr(state, "lidar"): return None
            return _to_array(state.lidar.data, np.float32)
        except Exception:
            return None
    def get_samples(self):
        samples = self._samples()
        if samples is None or samples.size == 0:
            return np.zeros(360, dtype=np.float32)
        return samples
    def get_num_samples(self):
        samples = self._samples()
        if samples is not None and samples.size > 0:
            return int(samples.size)
        return 360
    def get_samples_async(self):
        return self.get_samples()

class Camera:
    def _dims(self):
        w, h = 640, 480
        try:
            if not hasattr(js.window, "racecarState"): return w, h
            state = js.window.racecarState
            if not hasattr(state, "camera"): return w, h
            cam = state.camera
            w = int(cam.w); h = int(cam.h)
        except Exception:
            pass
        return w, h
    def _color_data(self):
        try:
            if not hasattr(js.window, "racecarState"): return None
            state = js.window.racecarState
            if not hasattr(state, "camera"): return None
            return _to_array(state.camera.data, np.uint8)
        except Exception:
            return None
    def get_color_image(self):
        w, h = self._dims()
        arr = self._color_data()
        if arr is None or arr.size != h * w * 4:
            return np.zeros((h, w, 3), dtype=np.uint8)
        arr = arr.reshape((h, w, 4))
        bgr = np.empty((h, w, 3), dtype=np.uint8)
        bgr[..., 0] = arr[..., 2]
        bgr[..., 1] = arr[..., 1]
        bgr[..., 2] = arr[..., 0]
        return bgr
    def get_color_image_no_copy(self):
        return self.get_color_image()
    def get_color_image_async(self):
        return self.get_color_image()
    def get_depth_image(self):
        w, h = self._dims()
        return np.zeros((h, w), dtype=np.float32)
    def get_depth_image_async(self):
        return self.get_depth_image()
    def get_width(self):
        return self._dims()[0]
    def get_height(self):
        return self._dims()[1]
    def get_max_range(self):
        return 1000.0

class Physics:
    def get_linear_acceleration(self):
        try:
            if not hasattr(js.window, "racecarState"): return (0.0, 0.0, 0.0)
            state = js.window.racecarState
            if not hasattr(state, "accel"): return (0.0, 0.0, 0.0)
            arr = _to_array(state.accel.data, np.float32)
        except Exception:
            return (0.0, 0.0, 0.0)
        if arr is None or arr.size < 3: return (0.0, 0.0, 0.0)
        return (float(arr[0]), float(arr[1]), float(arr[2]))
    def get_angular_velocity(self):
        try:
            if not hasattr(js.window, "racecarState"): return (0.0, 0.0, 0.0)
            state = js.window.racecarState
            if not hasattr(state, "gyro"): return (0.0, 0.0, 0.0)
            arr = _to_array(state.gyro.data, np.float32)
        except Exception:
            return (0.0, 0.0, 0.0)
        if arr is None or arr.size < 3: return (0.0, 0.0, 0.0)
        return (float(arr[0]), float(arr[1]), float(arr[2]))

class Controller:
    class Button(IntEnum):
        A = 0
        B = 1
        X = 2
        Y = 3
        LB = 4
        RB = 5
        LJOY = 6
        RJOY = 7
        START = 8
        BACK = 9
        LEFT_JOYSTICK = 6
        RIGHT_JOYSTICK = 7
    class Trigger(IntEnum):
        LEFT = 0
        RIGHT = 1
    class Joystick(IntEnum):
        LEFT = 0
        RIGHT = 1
    def _ctrl(self):
        try:
            if not hasattr(js.window, "racecarState"): return None
            c = js.window.racecarState
            return c.controller if hasattr(c, "controller") else None
        except Exception:
            return None
    def is_down(self, button):
        c = self._ctrl()
        return bool(c and (c.down & (1 << int(button))))
    def was_pressed(self, button):
        c = self._ctrl()
        return bool(c and (c.pressed & (1 << int(button))))
    def was_released(self, button):
        c = self._ctrl()
        return bool(c and (c.released & (1 << int(button))))
    def get_trigger(self, trigger):
        c = self._ctrl()
        if not c: return 0.0
        return c.tl if int(trigger) == 0 else c.tr
    def get_joystick(self, joystick):
        c = self._ctrl()
        if not c: return (0.0, 0.0)
        return (c.jlx, c.jly) if int(joystick) == 0 else (c.jrx, c.jry)

class Display:
    def __init__(self):
        self._matrix = np.zeros((8, 24), dtype=np.uint8)
    def create_window(self):
        pass
    def show_image(self, image):
        pass
    def show_color_image(self, image):
        pass
    def show_depth_image(self, image, max_depth=1000, points=None):
        pass
    def show_lidar(self, samples, radius=128, max_range=1000, highlighted_samples=None):
        pass
    def get_matrix(self):
        return self._matrix
    def new_matrix(self):
        return np.zeros((8, 24), dtype=np.uint8)
    def set_matrix(self, matrix):
        arr = np.asarray(matrix, dtype=np.uint8)
        if arr.size == 8 * 24:
            self._matrix = arr.reshape(8, 24)
    def set_matrix_intensity(self, intensity):
        pass
    def show_text(self, text, scroll_speed=2.0):
        pass

class Telemetry:
    def __init__(self):
        self._names = None
        self._data = []
    def declare_variables(self, *names):
        if self._names is not None: return
        self._names = list(names)
    def record(self, *values):
        if self._names is None:
            raise RuntimeError("Telemetry.record() called before declare_variables().")
        if len(values) != len(self._names):
            raise ValueError("Telemetry.record() value count mismatch.")
        self._data.append(tuple(values))
    def visualize(self):
        pass

class Racecar:
    def __init__(self):
        self.drive = Drive()
        self.lidar = Lidar()
        self.camera = Camera()
        self.physics = Physics()
        self.controller = Controller()
        self.display = Display()
        self.telemetry = Telemetry()
        self._update_slow_time = 1.0

    def set_start_update(self, start_func, update_func, update_slow_func=None):
        self._start_func = start_func
        self._update_func = update_func
        self._update_slow_func = update_slow_func
        self._proxy = create_proxy(self)
        js.window.unityRegisterRacecar(self._proxy)

    def set_update_slow_time(self, time):
        self._update_slow_time = float(time)
        try:
            js.window._rc_updateSlowTime = self._update_slow_time
        except Exception:
            pass

    def get_delta_time(self):
        try:
            dt = js.window._rc_deltaTime
            if dt:
                return float(dt)
        except Exception:
            pass
        return 1.0 / 60.0

    def go(self):
        pass

def create_racecar(_isSimulation=None):
    return Racecar()
`;
            utilsCode = `# Minimal fallback: if fetch of racecar_utils.py failed (file://), this stub
# provides the most commonly used helpers with the correct signatures.
# Full implementation lives in racecar_utils.py on disk.
# If you see this message, run: python server.py and open http://127.0.0.1:8000
print("[WARN] racecar_utils.py full library not loaded, using minimal shim")
print("[WARN] Run python server.py instead of opening file:// for full functionality")

import numpy as np
import cv2

def clamp(value, min, max):
    return min if value < min else max if value > max else value

def remap_range(value, old_min, old_max, new_min, new_max, saturate=False):
    new_val = new_min + (new_max - new_min) * (float(value - old_min) / float(old_max - old_min))
    if saturate:
        if new_min < new_max:
            return clamp(new_val, new_min, new_max)
        return clamp(new_val, new_max, new_min)
    return new_val

def crop(image, top_left, bottom_right):
    return image[top_left[0]:bottom_right[0], top_left[1]:bottom_right[1]]

def stack_images_horizontal(image_0, image_1):
    return np.hstack((image_0, image_1))

def stack_images_vertical(image_0, image_1):
    return np.vstack((image_0, image_1))

def find_contours(color_image, hsv_lower, hsv_upper):
    hsv = cv2.cvtColor(color_image, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, hsv_lower, hsv_upper)
    return cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0]

def get_largest_contour(contours, min_area=30):
    if len(contours) == 0: return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < min_area: return None
    return largest

def get_contour_center(contour):
    M = cv2.moments(contour)
    if M["m00"] <= 0: return None
    return (round(M["m01"] / M["m00"]), round(M["m10"] / M["m00"]))

def get_contour_area(contour):
    return cv2.contourArea(contour)

def draw_contour(color_image, contour, color=(0, 255, 0)):
    cv2.drawContours(color_image, [contour], 0, color, 3)

def draw_circle(color_image, center, color=(0, 255, 255), radius=6):
    cv2.circle(color_image, (center[1], center[0]), radius, color, -1)

def get_depth_image_center_distance(depth_image, kernel_size=5):
    h, w = depth_image.shape
    return float(depth_image[h // 2, w // 2])

def get_closest_pixel(depth_image, kernel_size=5):
    idx = int(np.argmin(depth_image))
    return (idx // depth_image.shape[1], idx % depth_image.shape[1])

def colormap_depth_image(depth_image, max_depth=1000):
    np.clip(depth_image, None, max_depth, depth_image)
    depth_image = (depth_image - 0.01) % max_depth
    return cv2.applyColorMap(-cv2.convertScaleAbs(depth_image, alpha=255 / max_depth), cv2.COLORMAP_INFERNO)

def get_lidar_closest_point(scan, window=(0, 360)):
    if len(scan) == 0: return (0.0, 0.0)
    valid = np.where(scan > 0, scan, np.inf)
    idx = int(np.argmin(valid))
    return (idx * 360.0 / len(scan), float(valid[idx]))

def get_lidar_average_distance(scan, angle, window_angle=4):
    if len(scan) == 0: return 0.0
    angle %= 360
    center = int(angle * len(scan) / 360)
    n = max(1, int(window_angle / 2 * len(scan) / 360))
    vals = [float(scan[(center + i) % len(scan)]) for i in range(-n, n + 1) if scan[(center + i) % len(scan)] > 0]
    if not vals: return 0.0
    return sum(vals) / len(vals)

def pixelate_image(img, size=(24, 8)):
    w, h = size
    return cv2.resize(img, (w, h), interpolation=cv2.INTER_LINEAR)
`;
        }

        pyodideInstance.FS.writeFile('/home/pyodide/racecar_core.py', coreCode);
        pyodideInstance.FS.writeFile('/home/pyodide/racecar_utils.py', utilsCode);

        isPythonReady = true;
        statusBadge.textContent = "Pyodide Ready";
        statusBadge.classList.remove('loading');
        statusBadge.classList.add('ready');
        runBtn.classList.remove('disabled');
        runBtn.removeAttribute('disabled');
        if (chooseRunBtn) {
            chooseRunBtn.classList.remove('disabled');
            chooseRunBtn.removeAttribute('disabled');
        }
        terminalEl.textContent += "Pyodide successfully initialized with NumPy, OpenCV, and Racecar libraries.\n";
    } catch (err) {
        statusBadge.textContent = "Error";
        terminalEl.textContent += "\n[Initialization Error]: " + err.message + "\n";
        terminalEl.textContent += "Please ensure the page is served over HTTP/HTTPS (not file://) and all repository files are present.\n";
        terminalEl.scrollTop = terminalEl.scrollHeight;
    }
}
initPyodide();

// --- 4. Unity WebGL & Pyodide Core Bridge ---
// Pre-initialize racecarState so physics never crashes if controller push arrives first,
// or if Python reads sensors before Unity's first physics push.
// NOTE: sensor payloads are exposed as `data`, NOT `to_py`. Pyodide's JsProxy
// already defines a `.to_py()` method, so a property named `to_py` was shadowed by
// it and `sensor.to_py()` in Python converted the *whole* sensor object (including
// the JS accessor function, as a JsProxy) into a dict — which numpy then could not
// cast. Naming the payload `data` avoids the collision entirely.
window.racecarState = window.racecarState || {};
window.racecarState.accel = window.racecarState.accel || { data: [0, 0, 0] };
window.racecarState.gyro = window.racecarState.gyro || { data: [0, 0, 0] };

window.unityPushState = function (ax, ay, az, gx, gy, gz) {
    window.racecarState = window.racecarState || {};
    window.racecarState.accel = { data: [ax, ay, az] };
    window.racecarState.gyro = { data: [gx, gy, gz] };
};

window.unityPushLidar = function (samplesFloat32) {
    window.racecarState = window.racecarState || {};
    window.racecarState.lidar = { data: samplesFloat32 };
};

window.unityPushCamera = function (pixelsUint8, w, h) {
    window.racecarState = window.racecarState || {};
    // Unity may send camera data as a plain JS object (dict), a raw ArrayBuffer,
    // or a Uint8Array, depending on how the C# side marshals the byte array.
    // Normalize all of these to a flat Uint8Array so numpy can ingest it.
    var data = pixelsUint8;
    if (data instanceof ArrayBuffer) {
        data = new Uint8Array(data);
    } else if (data && typeof data === 'object' &&
        !(data instanceof Uint8Array) &&
        !(data instanceof Uint8ClampedArray)) {
        // Object/dict case: convert values to a flat Uint8Array.
        // Object.values() gives us the pixel values in order (assuming
        // Unity marshalled them with sequential numeric keys).
        var vals = Object.values(data);
        data = new Uint8Array(vals);
    }
    window.racecarState.camera = { data: data, w: w, h: h };
};

window.unityPushController = function (down, pressed, released, tl, tr, jlx, jly, jrx, jry) {
    window.racecarState = window.racecarState || {};
    window.racecarState.controller = { down, pressed, released, tl, tr, jlx, jly, jrx, jry };
};

// --- Keyboard-to-Controller Mapping (fixed) ---
// Maps keyboard keys to RACECAR-MN Xbox controller buttons/axes:
//   Buttons: A=0, B=1, X=2, Y=3, LB=4, RB=5, LJoy=6, RJoy=7, START=8, BACK=9
//   Left Joystick: W/S = Y-axis, A/D = X-axis (or arrow keys)
//   Right Joystick: I/K = Y-axis, J/L = X-axis
//   Triggers:  Left=Q (hold), Right=E (hold)
//   Buttons:  Z=A(0), X=B(1), C=X(2), V=Y(3), U=LB(4), O=RB(5), Enter=START(8), Backspace=BACK(9)
// FIX: key handlers only update heldKeys + pending masks; _kbControllerTick is the sole
// consumer that builds final controller and clears pending. This prevents edge loss where
// buildControllerState() was called on keydown and again on _kbControllerTick before Python reads it.
// Also unityPushController now only stores _unityController, defers build to tick.
(function () {
    const KEY_BUTTON_MAP = {
        'KeyZ': 0, 'KeyX': 1, 'KeyC': 2, 'KeyV': 3,
        'KeyU': 4, 'KeyO': 5, 'Enter': 8, 'Backspace': 9,
    };

    const heldKeys = new Set();
    let pendingPressed = 0;
    let pendingReleased = 0;

    function buildControllerState() {
        window.racecarState = window.racecarState || {};
        const uc = window.racecarState._unityController;

        // --- Buttons bitmask from held keys ---
        let downMask = 0;
        for (const [code, bit] of Object.entries(KEY_BUTTON_MAP)) {
            if (heldKeys.has(code)) downMask |= (1 << bit);
        }
        if (uc) downMask |= uc.down;

        const pressedMask = pendingPressed | (uc ? uc.pressed : 0);
        const releasedMask = pendingReleased | (uc ? uc.released : 0);
        // Edge events last exactly one frame — clear after building
        pendingPressed = 0;
        pendingReleased = 0;

        // --- Triggers ---
        const tl = heldKeys.has('KeyQ') ? 1.0 : (uc ? uc.tl : 0.0);
        const tr = heldKeys.has('KeyE') ? 1.0 : (uc ? uc.tr : 0.0);

        // --- Left joystick: explicit keyboard override, fallback to Unity ---
        let jlx = 0, jly = 0, jlxKb = false, jlyKb = false;
        if (heldKeys.has('KeyA') || heldKeys.has('ArrowLeft')) { jlx = -1.0; jlxKb = true; }
        if (heldKeys.has('KeyD') || heldKeys.has('ArrowRight')) { jlx = 1.0; jlxKb = true; }
        if (heldKeys.has('KeyW') || heldKeys.has('ArrowUp')) { jly = 1.0; jlyKb = true; }
        if (heldKeys.has('KeyS') || heldKeys.has('ArrowDown')) { jly = -1.0; jlyKb = true; }
        if (uc) {
            if (!jlxKb) jlx = uc.jlx;
            if (!jlyKb) jly = uc.jly;
        }

        // --- Right joystick: IJKL explicit ---
        let jrx = 0, jry = 0, jrxKb = false, jryKb = false;
        if (heldKeys.has('KeyJ')) { jrx = -1.0; jrxKb = true; }
        if (heldKeys.has('KeyL')) { jrx = 1.0; jrxKb = true; }
        if (heldKeys.has('KeyI')) { jry = 1.0; jryKb = true; }
        if (heldKeys.has('KeyK')) { jry = -1.0; jryKb = true; }
        if (uc) {
            if (!jrxKb) jrx = uc.jrx;
            if (!jryKb) jry = uc.jry;
        }

        window.racecarState.controller = {
            down: downMask, pressed: pressedMask, released: releasedMask,
            tl, tr, jlx, jly, jrx, jry
        };
    }

    // Store Unity controller data, defer final merge to _kbControllerTick
    const _origPush = window.unityPushController;
    window.unityPushController = function (down, pressed, released, tl, tr, jlx, jly, jrx, jry) {
        window.racecarState = window.racecarState || {};
        window.racecarState._unityController = { down, pressed, released, tl, tr, jlx, jly, jrx, jry };
        // Do NOT call buildControllerState here — let _kbControllerTick be sole consumer
    };

    function isTypingTarget(e) {
        const t = e.target;
        return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    }

    document.addEventListener('keydown', (e) => {
        if (isTypingTarget(e)) return;
        if (heldKeys.has(e.code)) return;
        heldKeys.add(e.code);
        const bit = KEY_BUTTON_MAP[e.code];
        if (bit !== undefined) pendingPressed |= (1 << bit);
        // No buildControllerState() here — defer to tick
    }, false);

    document.addEventListener('keyup', (e) => {
        if (isTypingTarget(e)) return;
        heldKeys.delete(e.code);
        const bit = KEY_BUTTON_MAP[e.code];
        if (bit !== undefined) pendingReleased |= (1 << bit);
        // No build here either
    }, false);

    document.addEventListener('click', (e) => {
        if (e.target && (e.target.id === 'unity-canvas' || (e.target.closest && e.target.closest('#unity-container')))) {
            const canvas = document.getElementById('unity-canvas');
            if (canvas && typeof canvas.focus === 'function') canvas.focus();
        }
    });

    window._kbControllerTick = function () { buildControllerState(); };
    // Initial build so controller exists before first Unity push
    buildControllerState();
})();

window.unitySetDrive = function (speed, angle) {
    if (!window.unityInstance) return;

    // Send package 22 (Header.drive_set_speed_angle) to Unity
    const buffer = new ArrayBuffer(12);
    const view = new DataView(buffer);
    view.setUint8(0, 22); // Header index
    view.setFloat32(4, speed, true);
    view.setFloat32(8, angle, true);

    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    window.unityInstance.SendMessage('BrowserMessageReceiver', 'ReceiveFromJS', base64);
};

window.unityStopDrive = function () {
    if (!window.unityInstance) return;
    const buffer = new ArrayBuffer(1);
    const view = new DataView(buffer);
    view.setUint8(0, 23); // Header.drive_stop
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    window.unityInstance.SendMessage('BrowserMessageReceiver', 'ReceiveFromJS', base64);
};

window.unitySetMaxSpeed = function (speed) {
    if (!window.unityInstance) return;
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint8(0, 24); // Header.drive_set_max_speed
    view.setFloat32(4, speed, true);
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    window.unityInstance.SendMessage('BrowserMessageReceiver', 'ReceiveFromJS', base64);
};

// Connect heartbeat: Unity's BrowserMessageReceiver only exists once a level scene
// is loaded, not at main menu. A connect packet sent at registration time (main menu)
// is dropped. Keep announcing ourselves (idempotent) until Unity starts driving us.
let connectHeartbeat = null;
let slowTimer = 0;
let lastUnityFrameTime = 0;

window.unityRegisterRacecar = function (racecar) {
    activeRacecar = racecar;
    // Cache the Python callback functions via direct property access on the PyProxy.
    // In Pyodide, PyProxy exposes Python attributes as JS properties — there is no
    // .getattr() method on the JS side. Each property access returns a new PyProxy
    // for the underlying Python callable, so we grab them once and hold on.
    try {
        window._rc_startFunc = racecar._start_func || null;
    } catch (e) { window._rc_startFunc = null; }
    try {
        window._rc_updateFunc = racecar._update_func || null;
    } catch (e) { window._rc_updateFunc = null; }
    try {
        window._rc_updateSlowFunc = racecar._update_slow_func || null;
    } catch (e) { window._rc_updateSlowFunc = null; }
    try {
        window._rc_updateSlowTime = racecar._update_slow_time || 1.0;
    } catch (e) { window._rc_updateSlowTime = 1.0; }

    window.isPythonRunning = true;
    // Unity will not offer User Program mode until it receives a connect packet,
    // but its receiver GameObject only exists once a level scene is loaded — a
    // connect sent now, at the main menu, is dropped. Keep announcing ourselves
    // (idempotent on the Unity side) until Unity starts driving the loop.
    sendConnectToUnity();
    if (connectHeartbeat !== null) clearInterval(connectHeartbeat);
    connectHeartbeat = setInterval(sendConnectToUnity, 1000);
    terminalEl.textContent += "Racecar registered successfully. Active loop established.\n";
    terminalEl.textContent += "(Connecting to simulator — start a level to activate the loop.)\n";
};

// Hook C# callbacks triggered by Unity's Update loop
window.unityToPython = function (bytes) {
    if (!activeRacecar) return;
    const header = bytes[0];

    // Unity is driving us now, so it has our connect
    if (connectHeartbeat !== null) {
        clearInterval(connectHeartbeat);
        connectHeartbeat = null;
    }

    // Track the real elapsed time since the previous Unity frame so
    // rc.get_delta_time() reports actual timing instead of a hardcoded 1/60 s.
    const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
    window._rc_deltaTime = lastUnityFrameTime ? (now - lastUnityFrameTime) / 1000 : (1 / 60);
    lastUnityFrameTime = now;

    try {
        if (header === 2) { // unity_start
            slowTimer = 0;
            if (window._kbControllerTick) window._kbControllerTick();
            if (window._rc_startFunc) {
                window._rc_startFunc();
            }
            sendFinishedToUnity(false);
        } else if (header === 3) { // unity_update
            if (window._kbControllerTick) window._kbControllerTick();
            if (window._rc_updateFunc) {
                window._rc_updateFunc();
            }
            slowTimer += 1 / 60;
            if (window._rc_updateSlowFunc && slowTimer >= (window._rc_updateSlowTime || 1.0)) {
                slowTimer = 0;
                window._rc_updateSlowFunc();
            }
            sendFinishedToUnity(false);
        } else if (header === 4) { // unity_exit (from Unity exiting User Program mode)
            stopProgram();
        }
    } catch (err) {
        console.error("[Python Loop Error]", err);
        // Print the traceback ONCE, then halt the loop. Unity keeps invoking
        // unityToPython at ~60 fps while a level is active, so without stopping
        // here the same error is re-raised and re-printed every frame, flooding
        // the terminal until the user manually presses Stop.
        terminalMsg("Python Loop Error: " + (err.message || err), "error");
        sendErrorToUnity(err.message);
        stopProgram();
    }
};

window.unityToPythonAsync = function (bytes) {
    // Fallback for async updates
    console.log("Async packet from Unity: ", bytes);
};

function sendFinishedToUnity(isAsync) {
    if (!window.unityInstance) return;
    const buffer = new ArrayBuffer(1);
    const view = new DataView(buffer);
    view.setUint8(0, 5); // Header.python_finished
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    if (isAsync) {
        window.unityInstance.SendMessage('BrowserMessageReceiver', 'ReceiveFromJSAsync', base64);
    } else {
        window.unityInstance.SendMessage('BrowserMessageReceiver', 'ReceiveFromJS', base64);
    }
}

function sendErrorToUnity(message) {
    if (!window.unityInstance) return;
    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    view.setUint8(0, 0); // Header.error
    view.setUint8(1, 2); // Error.python_exception
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    window.unityInstance.SendMessage('BrowserMessageReceiver', 'ReceiveFromJS', base64);
}

function sendConnectToUnity() {
    if (!window.unityInstance) return;
    const buffer = new ArrayBuffer(1);
    const view = new DataView(buffer);
    view.setUint8(0, 1); // Header.connect
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    window.unityInstance.SendMessage('BrowserMessageReceiver', 'ReceiveFromJS', base64);
}

function sendPythonExitToUnity() {
    if (!window.unityInstance) return;
    const buffer = new ArrayBuffer(1);
    const view = new DataView(buffer);
    view.setUint8(0, 7); // Header.python_exit
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    window.unityInstance.SendMessage('BrowserMessageReceiver', 'ReceiveFromJS', base64);
}

// --- 5. Run Execution Action ---
let lastRunFile = null;

function ensurePyodideDir(filePath) {
    if (!pyodideInstance || !pyodideInstance.FS) return;
    const parts = filePath.split('/');
    if (parts.length > 1) {
        let cur = '/home/pyodide';
        for (let i = 0; i < parts.length - 1; i++) {
            cur += '/' + parts[i];
            try {
                pyodideInstance.FS.mkdir(cur);
            } catch (e) {
                // Folder already exists
            }
        }
    }
}

async function runFile(targetFile) {
    if (!isPythonReady) return;
    if (!targetFile || !files[targetFile]) {
        terminalEl.textContent += `> No valid file to run.\n`;
        return;
    }

    saveCurrentFile();
    lastRunFile = targetFile;

    terminalEl.textContent = `> Running ${targetFile}...\n`;
    runBtn.classList.add('hidden');
    if (chooseRunBtn) chooseRunBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');

    try {
        // Ensure parent directories exist in Pyodide MEMFS
        // WARNING: DO NOT add literal '\n' characters at the end of function calls here.
        // A previous bug injected 'ensurePyodideDir(targetFile);\n' which caused a JavaScript SyntaxError
        // because it was evaluated as an invalid newline token, breaking the entire UI initialization!
        ensurePyodideDir(targetFile);
        // Sync all workspace files so sibling imports work (e.g. import my_helper)
        try {
            for (const [p, content] of Object.entries(files)) {
                if (p === targetFile) continue;
                if (p.endsWith('/')) {
                    // Folder marker — ensure it exists as dir
                    ensurePyodideDir(p + '.keep');
                    continue;
                }
                try {
                    ensurePyodideDir(p);
                    // For non-target files, write raw (or preprocessed if you want consistency)
                    pyodideInstance.FS.writeFile(`/home/pyodide/${p}`, content);
                } catch (e) {
                    console.warn(`Failed to sync workspace file ${p} to Pyodide FS`, e);
                }
            }
        } catch (e) {
            console.warn("Workspace sync to Pyodide failed:", e);
        }
        // --- Preprocess user code for Pyodide compatibility ---
        let userCode = files[targetFile];

        // Neutralize sys.path.insert calls that reference relative library paths
        // (../library, ../../library) — racecar_core is already at /home/pyodide.
        userCode = userCode.replace(
            /sys\.path\.insert\s*\(\s*\d+\s*,\s*['"][^'"]*library[^'"]*['"]\s*\)/g,
            'pass  # sys.path.insert neutralized (racecar_core available via Pyodide)'
        );

        // Write preprocessed code to Pyodide FS
        pyodideInstance.FS.writeFile(`/home/pyodide/${targetFile}`, userCode);

        // Determine the directory of the file for relative imports
        const fileDir = targetFile.includes('/') 
            ? '/home/pyodide/' + targetFile.substring(0, targetFile.lastIndexOf('/'))
            : '/home/pyodide';

        // Clean up previous user-defined globals and run user program safely
        const safePath = JSON.stringify('/home/pyodide/' + targetFile);
        const safeDir  = JSON.stringify(fileDir);
        await pyodideInstance.runPythonAsync(`
import sys, os

# Ensure racecar libraries are always importable regardless of nesting depth
for _p in ('/home/pyodide',):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Add the file's own directory so relative sibling imports work
_file_dir = ${safeDir}
if _file_dir not in sys.path:
    sys.path.insert(0, _file_dir)

# Clean up previous user-defined globals (keep builtins and racecar libs)
to_delete = [k for k in list(globals().keys())
             if not k.startswith('__')
             and k not in ('sys', 'os', 'pyodide', 'rc', 'racecar_core', 'racecar_utils')]
for k in to_delete:
    del globals()[k]

# Execute the user script — __name__ is '__main__' so the guard block fires
with open(${safePath}, "r") as _f:
    exec(compile(_f.read(), ${safePath}, 'exec'), globals())
        `);
    } catch (err) {
        terminalEl.textContent += `\n[Compile Error]: ${err.message}\n`;
        stopProgram();
    }
}

runBtn.addEventListener('click', () => {
    runFile(currentFile);
});

if (chooseRunBtn) {
    chooseRunBtn.addEventListener('click', () => {
        if (!lastRunFile) {
            terminalEl.textContent += `> No previously run file. Running current file (${currentFile})...\n`;
            runFile(currentFile);
        } else {
            runFile(lastRunFile);
        }
    });
}

function stopProgram() {
    // Stop the connect heartbeat so a terminated program doesn't keep announcing
    // itself to Unity every second (which would otherwise re-enter User Program
    // mode for an already-stopped program once a level later loads).
    if (connectHeartbeat !== null) {
        clearInterval(connectHeartbeat);
        connectHeartbeat = null;
    }

    // Destroy cached PyProxy callback references
    if (window._rc_startFunc && typeof window._rc_startFunc.destroy === 'function') {
        try { window._rc_startFunc.destroy(); } catch (e) { }
    }
    if (window._rc_updateFunc && typeof window._rc_updateFunc.destroy === 'function') {
        try { window._rc_updateFunc.destroy(); } catch (e) { }
    }
    if (window._rc_updateSlowFunc && typeof window._rc_updateSlowFunc.destroy === 'function') {
        try { window._rc_updateSlowFunc.destroy(); } catch (e) { }
    }
    window._rc_startFunc = null;
    window._rc_updateFunc = null;
    window._rc_updateSlowFunc = null;

    if (activeRacecar && typeof activeRacecar.destroy === 'function') {
        try { activeRacecar.destroy(); } catch (e) { }
    }
    activeRacecar = null;
    window.isPythonRunning = false;
    sendPythonExitToUnity();

    runBtn.classList.remove('hidden');
    if (chooseRunBtn) chooseRunBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    terminalEl.textContent += "\n> Process terminated.\n";
}

stopBtn.addEventListener('click', stopProgram);

// --- 6. Settings Panel & Desktop Window Management ---
function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const themeBtns = document.querySelectorAll('.theme-btn');
    themeBtns.forEach(btn => {
        if (btn.dataset.setTheme === theme) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    if (window.monaco && editor) {
        monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
    }
    localStorage.setItem('racecar-theme', theme);
}

document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (e.target.dataset.setTheme) {
            setTheme(e.target.dataset.setTheme);
        }
    });
});

const savedTheme = localStorage.getItem('racecar-theme') || 'dark';
setTheme(savedTheme);

// --- Fullscreen Handler ---
const fullscreenBtn = document.getElementById('tray-fullscreen');
if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', async () => {
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

        if (!isFullscreen) {
            const docEl = document.documentElement;
            try {
                if (docEl.requestFullscreen) {
                    await docEl.requestFullscreen();
                } else if (docEl.webkitRequestFullscreen) {
                    docEl.webkitRequestFullscreen();
                } else if (docEl.mozRequestFullScreen) {
                    docEl.mozRequestFullScreen();
                } else if (docEl.msRequestFullscreen) {
                    docEl.msRequestFullscreen();
                } else {
                    terminalMsg("Your browser does not support the Fullscreen API.", "error");
                    return;
                }

                // Check if the viewport actually resized to the physical monitor screen size
                setTimeout(async () => {
                    if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement) {
                        const screenW = window.screen.width;
                        const screenH = window.screen.height;
                        const winW = window.innerWidth;
                        const winH = window.innerHeight;
                        // If viewport is significantly smaller than the physical screen, we are trapped in an iframe
                        if (Math.abs(winW - screenW) > 100 || Math.abs(winH - screenH) > 100) {
                            terminalMsg("Fullscreen is enabled, but the viewport didn't expand to fill your monitor. This happens when viewing the OS inside an IDE preview window or a constrained iframe. For a true fullscreen experience, open index.html directly in a normal browser tab.", "warn");
                        }
                    }
                }, 600);

            } catch (err) {
                console.error("Fullscreen error:", err);
                terminalMsg("Fullscreen could not be activated: " + err.message, "error");
            }
        } else {
            try {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                } else if (document.mozCancelFullScreen) {
                    document.mozCancelFullScreen();
                } else if (document.msExitFullscreen) {
                    document.msExitFullscreen();
                }
            } catch (err) {
                console.error("Exit fullscreen error:", err);
            }
        }
    });

    document.addEventListener('fullscreenerror', async () => {
        terminalMsg("Fullscreen could not be activated. If you are viewing this in an IDE preview window, it is blocking fullscreen access. Right-click the file and open it in a normal web browser.", "error");
    });
}

// --- Tray Export (All Data & Workspace Package) ---
const trayExportBtn = document.getElementById('tray-export');
if (trayExportBtn) {
    trayExportBtn.addEventListener('click', () => {
        saveCurrentFile();
        hasUnexportedData = false;

        const fullPackage = {
            version: "1.0.0",
            type: "racecar_full_user_data_package",
            exportDate: new Date().toISOString(),
            files: files || {},
            expandedFolders: expandedFolders || {},
            settings: {
                theme: localStorage.getItem('racecar-theme') || 'dark',
                autoSaveMode: localStorage.getItem('autosave-mode') || 'auto',
                autoHideTaskbar: localStorage.getItem('autohide-taskbar') === 'true',
                warnExport: localStorage.getItem('warn-export') !== 'false',
                taskbarPosFloating: localStorage.getItem('taskbar-pos-floating') || 'bottom-center',
                taskbarPosMax: localStorage.getItem('taskbar-pos-max') || 'bottom-center',
                taskbarSizeFloating: localStorage.getItem('taskbar-size-floating') || 'medium',
                taskbarSizeMax: localStorage.getItem('taskbar-size-max') || 'medium',
                pinnedApps: (() => {
                    try { return JSON.parse(localStorage.getItem('racecar_pinned_apps')); } catch (e) { return null; }
                })(),
                windowStates: (() => {
                    try { return JSON.parse(localStorage.getItem('racecar_window_states')); } catch (e) { return null; }
                })()
            }
        };

        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
        const filename = `racecar_full_backup_${timestamp}.json`;

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(fullPackage, null, 4));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", filename);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();

        if (terminalEl) {
            terminalEl.textContent += `> Successfully exported complete user data & workspace to ${filename}\n`;
            terminalEl.scrollTop = terminalEl.scrollHeight;
        }
    });
}

// --- Workspace Import (All Data & Workspace Package) ---
// Triggered from the Settings window (Import button) via the hidden file input.
const trayImportInput = document.getElementById('tray-import-input');
if (trayImportInput) {
    const settingsImportBtn = document.getElementById('settings-import-btn');
    if (settingsImportBtn) {
        settingsImportBtn.addEventListener('click', () => trayImportInput.click());
    }
    trayImportInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (evt) => {
            try {
                const data = JSON.parse(evt.target.result);
                if (data.files) {
                    files = data.files;
                    localStorage.setItem('racecar_files', JSON.stringify(files));
                }
                if (data.expandedFolders) {
                    expandedFolders = data.expandedFolders;
                    localStorage.setItem('racecar_expanded_folders', JSON.stringify(expandedFolders));
                }
                if (data.settings) {
                    const s = data.settings;
                    if (s.theme) localStorage.setItem('racecar-theme', s.theme);
                    if (s.autoSaveMode) localStorage.setItem('autosave-mode', s.autoSaveMode);
                    if (s.autoHideTaskbar !== undefined) localStorage.setItem('autohide-taskbar', s.autoHideTaskbar);
                    if (s.warnExport !== undefined) localStorage.setItem('warn-export', s.warnExport);
                    if (s.taskbarPosFloating) localStorage.setItem('taskbar-pos-floating', s.taskbarPosFloating);
                    if (s.taskbarPosMax) localStorage.setItem('taskbar-pos-max', s.taskbarPosMax);
                    if (s.taskbarSizeFloating) localStorage.setItem('taskbar-size-floating', s.taskbarSizeFloating);
                    if (s.taskbarSizeMax) localStorage.setItem('taskbar-size-max', s.taskbarSizeMax);
                    if (s.pinnedApps) localStorage.setItem('racecar_pinned_apps', JSON.stringify(s.pinnedApps));
                    if (s.windowStates) localStorage.setItem('racecar_window_states', JSON.stringify(s.windowStates));
                }

                hasUnexportedData = false;
                terminalMsg("Complete user data & workspace imported successfully. Reloading page...", "success");
                location.reload();
            } catch (err) {
                terminalMsg("Failed to import backup package: " + err.message, "error");
            }
        };
        reader.readAsText(file);
    });
}

function checkMaximizedWindows() {
    const taskbarEl = document.getElementById('taskbar');
    const anyMax = Array.from(document.querySelectorAll('.window')).some(win =>
        (win.classList.contains('maximized') || win.classList.contains('snapped')) &&
        !win.classList.contains('hidden') && !win.classList.contains('minimized')
    );
    if (anyMax) {
        document.body.classList.add('has-maximized');
        if (taskbarEl) taskbarEl.setAttribute('data-mode', 'maximized');
    } else {
        document.body.classList.remove('has-maximized');
        if (taskbarEl) taskbarEl.setAttribute('data-mode', 'floating');
    }
    if (typeof updateTaskbarMode === 'function') updateTaskbarMode();
}

// Window Dragging & Z-Index Management
let highestZIndex = 20;

document.querySelectorAll('.window').forEach(win => {
    // Controls
    const btnMin = win.querySelector('.win-min');
    const btnMax = win.querySelector('.win-max');
    const btnClose = win.querySelector('.win-close');
    const btnCloseSettings = win.querySelector('.win-close-settings');

    if (btnMin) {
        btnMin.addEventListener('click', () => {
            win.classList.add('minimized');
            updateTaskbarIcons();
            checkMaximizedWindows();
            saveWindowStates();
        });
    }
    if (btnMax) {
        btnMax.addEventListener('click', () => {
            if (win.classList.contains('maximized')) {
                win.classList.remove('maximized');
            } else {
                win.classList.add('maximized');
                win.classList.remove('snapped');
            }
            checkMaximizedWindows();
            saveWindowStates();
        });
    }
    const handleClose = () => {
        win.classList.add('hidden');
        updateTaskbarIcons();
        checkMaximizedWindows();
        saveWindowStates();

        if (win.id === 'window-simulator') {
            if (window.unityInstance) {
                window.unityInstance.Quit().then(() => {
                    window.unityInstance = null;
                    const canvas = document.getElementById('unity-canvas');
                    if (canvas) {
                        const newCanvas = canvas.cloneNode(true);
                        canvas.parentNode.replaceChild(newCanvas, canvas);
                    }
                    const unityStatus = document.getElementById('unity-status');
                    if (unityStatus) {
                        unityStatus.textContent = "Offline";
                        unityStatus.className = 'status-badge error';
                    }
                    const loadingBar = document.getElementById('unity-loading-bar');
                    if (loadingBar) loadingBar.style.display = 'none';
                }).catch(err => {
                    console.error("Failed to quit Unity cleanly:", err);
                    window.unityInstance = null;
                });
            }
        } else if (win.id === 'window-coder') {
            // Just hide — don't reset the file or clear the terminal.
            // The editor state and terminal history are preserved so
            // re-opening is instant (just a layout refresh).
        }
    };

    if (btnClose) {
        btnClose.addEventListener('click', handleClose);
    }
    if (btnCloseSettings) {
        btnCloseSettings.addEventListener('click', handleClose);
    }
});

// Taskbar Logic
const taskbarIcons = document.querySelectorAll('.taskbar-icon');
function updateTaskbarIcons() {
    // Query live so dynamically-created icons (ensureTaskbarIcon) are included.
    document.querySelectorAll('.taskbar-icon').forEach(icon => {
        const targetId = icon.dataset.target;
        const win = document.getElementById(targetId);
        if (win && !win.classList.contains('hidden') && !win.classList.contains('minimized')) {
            icon.classList.add('active');
        } else {
            icon.classList.remove('active');
        }
    });
}

taskbarIcons.forEach(icon => {
    icon.addEventListener('click', () => {
        const targetId = icon.dataset.target;
        const win = document.getElementById(targetId);
        if (!win) return;

        if (win.classList.contains('hidden')) {
            win.classList.remove('hidden');
            win.classList.remove('minimized');
            win.style.zIndex = ++highestZIndex;

            // Check if Simulator needs restart
            if (win.id === 'window-simulator' && !window.unityInstance && typeof window.loadUnity === 'function') {
                window.loadUnity();
            }
            // Monaco loses layout dimensions when hidden (display:none).
            // Force immediate recalculation on re-show for instant rendering.
            if (win.id === 'window-coder' && typeof editor !== 'undefined' && editor && typeof editor.layout === 'function') {
                editor.layout();
            }
        } else if (win.classList.contains('minimized')) {
            win.classList.remove('minimized');
            win.style.zIndex = ++highestZIndex;
            if (win.id === 'window-coder') {
                // Keep transition:none (set during minimize). If we restore CSS
                // transitions now, the 0.2s scale(0)→scale(1) animation causes
                // getBoundingClientRect() to return continuously-changing values,
                // triggering ResizeObserver on every frame — expensive Monaco
                // re-layouts that make re-opening feel stuck.
                if (typeof editor !== 'undefined' && editor && typeof editor.layout === 'function') {
                    editor.layout();
                }
                // Restore transitions after layout settles
                setTimeout(() => { win.style.transition = ''; }, 150);
            }
        } else {
            // If it's already focused, minimize it. Otherwise, focus it.
            if (parseInt(win.style.zIndex || 0) === highestZIndex) {
                // Kill CSS transitions during minimize — otherwise Monaco's
                // ResizeObserver fires on every animation frame of the 0.2s
                // transform/opacity transition, triggering expensive re-layouts
                // that make the minimize feel stuck.
                if (win.id === 'window-coder') {
                    win.style.transition = 'none';
                    void win.offsetHeight; // force reflow to apply
                }
                win.classList.add('minimized');
            } else {
                win.style.zIndex = ++highestZIndex;
            }
        }
        updateTaskbarIcons();
        checkMaximizedWindows();
        saveWindowStates();
    });
});

// System Tray
const trayTime = document.getElementById('tray-time');
setInterval(() => {
    const now = new Date();
    trayTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}, 1000);

const trayBattery = document.getElementById('tray-battery');
if (navigator.getBattery) {
    navigator.getBattery().then(battery => {
        const updateBattery = () => {
            trayBattery.textContent = `🔋 ${Math.round(battery.level * 100)}%`;
        };
        updateBattery();
        battery.addEventListener('levelchange', updateBattery);
    });
}

// Prevent windows getting cut off on smaller screens
function clampWindows() {
    const wsTop = parseInt(document.body.style.getPropertyValue('--workspace-top') || 0);
    const wsLeft = parseInt(document.body.style.getPropertyValue('--workspace-left') || 0);
    const wsWidth = parseInt(document.body.style.getPropertyValue('--workspace-width') || window.innerWidth);
    const wsHeight = parseInt(document.body.style.getPropertyValue('--workspace-height') || window.innerHeight);

    document.querySelectorAll('.window').forEach(win => {
        if (win.classList.contains('maximized') || win.classList.contains('hidden') || win.classList.contains('minimized') || win.classList.contains('snapped')) return;

        let newX = win.offsetLeft;
        let newY = win.offsetTop;
        let newW = win.offsetWidth;
        let newH = win.offsetHeight;

        // Ensure it doesn't exceed workspace size
        if (newW > wsWidth) {
            newW = wsWidth;
            win.style.width = `${newW}px`;
        }
        if (newH > wsHeight) {
            newH = wsHeight;
            win.style.height = `${newH}px`;
        }

        // Ensure it's not off screen
        if (newX < wsLeft) newX = wsLeft;
        if (newY < wsTop) newY = wsTop;

        if (newX + newW > wsLeft + wsWidth) {
            newX = Math.max(wsLeft, wsLeft + wsWidth - newW);
        }
        if (newY + newH > wsTop + wsHeight) {
            newY = Math.max(wsTop, wsTop + wsHeight - newH);
        }

        win.style.left = `${newX}px`;
        win.style.top = `${newY}px`;
    });
}
window.addEventListener('resize', clampWindows);
setTimeout(clampWindows, 100);

// Auto-hide taskbar
const taskbar = document.getElementById('taskbar');
const autohideToggle = document.getElementById('autohide-taskbar');
const savedAutohide = localStorage.getItem('autohide-taskbar') === 'true';
autohideToggle.checked = savedAutohide;

autohideToggle.addEventListener('change', () => {
    localStorage.setItem('autohide-taskbar', autohideToggle.checked);
});

const autosaveSelect = document.getElementById('autosave-mode');
if (autosaveSelect) {
    autosaveSelect.value = autoSaveMode;
    autosaveSelect.addEventListener('change', (e) => {
        autoSaveMode = e.target.value;
        localStorage.setItem('autosave-mode', autoSaveMode);
        if (autoSaveMode === 'auto') saveCurrentFile(true);
    });
}

const warnExportToggle = document.getElementById('warn-export-toggle');
if (warnExportToggle) {
    warnExportToggle.checked = warnExportToggleVal;
    warnExportToggle.addEventListener('change', () => {
        warnExportToggleVal = warnExportToggle.checked;
        localStorage.setItem('warn-export', warnExportToggleVal);
    });
}

let taskbarHovered = false;
taskbar.addEventListener('mouseenter', () => taskbarHovered = true);
taskbar.addEventListener('mouseleave', () => taskbarHovered = false);

document.addEventListener('mousemove', (e) => {
    if (autohideToggle.checked) {
        const pos = taskbar.getAttribute('data-active-position') || 'bottom-center';
        let nearEdge = false;
        const threshold = 40;

        if (pos.startsWith('bottom-')) nearEdge = (e.clientY > window.innerHeight - threshold);
        else if (pos.startsWith('top-')) nearEdge = (e.clientY < threshold);
        else if (pos.startsWith('left-')) nearEdge = (e.clientX < threshold);
        else if (pos.startsWith('right-')) nearEdge = (e.clientX > window.innerWidth - threshold);

        if (nearEdge || taskbarHovered) {
            taskbar.classList.remove('autohide');
        } else {
            taskbar.classList.add('autohide');
        }
    } else {
        taskbar.classList.remove('autohide');
    }
});

// Taskbar Mode Update Function
function updateTaskbarMode() {
    const mode = taskbar.getAttribute('data-mode') || 'floating';

    let pos = taskbar.getAttribute('data-position') || 'bottom-center';
    let size = taskbar.getAttribute('data-size') || 'medium';

    let maxPos = taskbar.getAttribute('data-max-position') || 'bottom-center';
    let maxSize = taskbar.getAttribute('data-max-size') || 'medium';

    let activePos = mode === 'maximized' ? maxPos : pos;
    let activeSize = mode === 'maximized' ? maxSize : size;

    taskbar.setAttribute('data-active-position', activePos);
    taskbar.setAttribute('data-active-size', activeSize);

    let thickness = 56;
    if (activeSize === 'small') thickness = 44;
    else if (activeSize === 'large') thickness = 68;

    let wsTop = 0;
    let wsLeft = 0;
    let wsWidth = window.innerWidth;
    let wsHeight = window.innerHeight;

    if (activePos.startsWith('bottom-')) {
        wsHeight -= thickness;
    } else if (activePos.startsWith('top-')) {
        wsTop = thickness;
        wsHeight -= thickness;
    } else if (activePos.startsWith('left-')) {
        wsLeft = thickness;
        wsWidth -= thickness;
    } else if (activePos.startsWith('right-')) {
        wsWidth -= thickness;
    }

    document.body.style.setProperty('--workspace-top', wsTop + 'px');
    document.body.style.setProperty('--workspace-left', wsLeft + 'px');
    document.body.style.setProperty('--workspace-width', wsWidth + 'px');
    document.body.style.setProperty('--workspace-height', wsHeight + 'px');
}

window.addEventListener('resize', updateTaskbarMode);

// Taskbar Settings Listeners
function setupTaskbarSettings() {
    const floatingPosSpots = document.querySelectorAll('#taskbar-pos-floating .pos-spot');
    const maxPosSpots = document.querySelectorAll('#taskbar-pos-max .pos-spot');
    const floatingSize = document.getElementById('taskbar-size-floating');
    const maxSize = document.getElementById('taskbar-size-max');

    const savedPosFloat = localStorage.getItem('taskbar-pos-floating') || 'bottom-center';
    const savedPosMax = localStorage.getItem('taskbar-pos-max') || 'bottom-center';
    const savedSizeFloat = localStorage.getItem('taskbar-size-floating') || 'medium';
    const savedSizeMax = localStorage.getItem('taskbar-size-max') || 'medium';

    taskbar.setAttribute('data-position', savedPosFloat);
    taskbar.setAttribute('data-max-position', savedPosMax);
    taskbar.setAttribute('data-size', savedSizeFloat);
    taskbar.setAttribute('data-max-size', savedSizeMax);

    if (floatingSize) floatingSize.value = savedSizeFloat;
    if (maxSize) maxSize.value = savedSizeMax;

    floatingPosSpots.forEach(s => s.dataset.pos === savedPosFloat && s.classList.add('active'));
    maxPosSpots.forEach(s => s.dataset.pos === savedPosMax && s.classList.add('active'));

    floatingPosSpots.forEach(spot => spot.addEventListener('click', (e) => {
        e.stopPropagation();
        taskbar.setAttribute('data-position', spot.dataset.pos);
        floatingPosSpots.forEach(s => s.classList.remove('active'));
        spot.classList.add('active');
        localStorage.setItem('taskbar-pos-floating', spot.dataset.pos);
        localStorage.setItem('taskbar-position', spot.dataset.pos);
        updateTaskbarMode();
        setTimeout(clampWindows, 50);
    }));

    maxPosSpots.forEach(spot => spot.addEventListener('click', (e) => {
        e.stopPropagation();
        taskbar.setAttribute('data-max-position', spot.dataset.pos);
        maxPosSpots.forEach(s => s.classList.remove('active'));
        spot.classList.add('active');
        localStorage.setItem('taskbar-pos-max', spot.dataset.pos);
        updateTaskbarMode();
        setTimeout(clampWindows, 50);
    }));

    if (floatingSize) {
        floatingSize.addEventListener('change', (e) => {
            taskbar.setAttribute('data-size', e.target.value);
            localStorage.setItem('taskbar-size-floating', e.target.value);
            updateTaskbarMode();
            setTimeout(clampWindows, 50);
        });
    }
    if (maxSize) {
        maxSize.addEventListener('change', (e) => {
            taskbar.setAttribute('data-max-size', e.target.value);
            localStorage.setItem('taskbar-size-max', e.target.value);
            updateTaskbarMode();
            setTimeout(clampWindows, 50);
        });
    }

    updateTaskbarMode();
}
setupTaskbarSettings();

// Context Menu
const desktop = document.getElementById('desktop');
const contextMenu = document.getElementById('desktop-context-menu');

desktop.addEventListener('contextmenu', (e) => {
    // Only show if clicking directly on desktop background
    if (e.target.id === 'desktop') {
        e.preventDefault();
        contextMenu.style.left = `${e.clientX}px`;
        contextMenu.style.top = `${e.clientY}px`;
        contextMenu.classList.remove('hidden');
    }
});

document.addEventListener('click', () => {
    contextMenu.classList.add('hidden');
});

document.getElementById('ctx-show-all').addEventListener('click', () => {
    document.querySelectorAll('.window').forEach(win => {
        win.classList.remove('hidden');
        win.classList.remove('minimized');
    });
    updateTaskbarIcons();
    checkMaximizedWindows();
});

document.getElementById('ctx-toggle-taskbar').addEventListener('click', () => {
    autohideToggle.checked = !autohideToggle.checked;
    localStorage.setItem('autohide-taskbar', autohideToggle.checked);
});

// Workspace Collapsible
const workspaceToggle = document.getElementById('workspace-toggle');
const workspaceContent = document.getElementById('workspace-content');
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
const sidebarEl = document.getElementById('sidebar');

if (workspaceToggle) {
    workspaceToggle.addEventListener('click', () => {
        workspaceContent.classList.toggle('collapsed');
        workspaceToggle.textContent = workspaceContent.classList.contains('collapsed') ? 'Workspace ▶' : 'Workspace ▼';
    });
}

if (sidebarToggleBtn && sidebarEl) {
    sidebarToggleBtn.addEventListener('click', () => {
        sidebarEl.classList.toggle('sidebar-collapsed');
        if (sidebarEl.classList.contains('sidebar-collapsed')) {
            sidebarToggleBtn.textContent = '▶';
            sidebarToggleBtn.title = 'Expand Sidebar';
        } else {
            sidebarToggleBtn.textContent = '◀';
            sidebarToggleBtn.title = 'Collapse Sidebar';
        }
    });
}


// --- 4. Battery and Time Loop ---
function updateTray() {
    const timeEl = document.getElementById('tray-time');
    const batteryEl = document.getElementById('tray-battery');

    if (timeEl) {
        const now = new Date();
        timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    if (navigator.getBattery && batteryEl) {
        navigator.getBattery().then(battery => {
            const level = Math.round(battery.level * 100);
            batteryEl.textContent = `🔋 ${level}%`;
            batteryEl.title = `Battery: ${level}%`;

            battery.addEventListener('levelchange', () => {
                const newLevel = Math.round(battery.level * 100);
                batteryEl.textContent = `🔋 ${newLevel}%`;
                batteryEl.title = `Battery: ${newLevel}%`;
            });
        });
    }
}
setInterval(updateTray, 1000);
updateTray();

// --- 5. Window Management (Drag, Resize, Snap) ---

// Setup Windows
const windows = document.querySelectorAll('.window');
highestZIndex = 20;

function saveWindowStates() {
    const states = {};
    windows.forEach(win => {
        states[win.id] = {
            top: win.style.top,
            left: win.style.left,
            width: win.style.width,
            height: win.style.height,
            zIndex: win.style.zIndex,
            classes: Array.from(win.classList).filter(c => ['hidden', 'minimized', 'maximized'].includes(c))
        };
    });
    localStorage.setItem('racecar_window_states', JSON.stringify(states));
}

function loadWindowStates() {
    try {
        const saved = localStorage.getItem('racecar_window_states');
        if (!saved) return;
        const states = JSON.parse(saved);
        windows.forEach(win => {
            const state = states[win.id];
            if (state) {
                if (state.top) win.style.top = state.top;
                if (state.left) win.style.left = state.left;
                if (state.width) win.style.width = state.width;
                if (state.height) win.style.height = state.height;
                if (state.zIndex) {
                    win.style.zIndex = state.zIndex;
                    highestZIndex = Math.max(highestZIndex, parseInt(state.zIndex, 10));
                }
                win.classList.remove('hidden', 'minimized', 'maximized');
                state.classes.forEach(c => win.classList.add(c));
            }
        });
    } catch (e) {
        console.error("Failed to load window states", e);
    }
    checkMaximizedWindows();
    updateTaskbarIcons();
}

loadWindowStates();

windows.forEach(win => {
    // 1. Bring to front on click
    win.addEventListener('mousedown', () => {
        highestZIndex++;
        win.style.zIndex = highestZIndex;
    });

    // 2. Add Resizers
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    handles.forEach(h => {
        const div = document.createElement('div');
        div.className = `resizer resizer-${h}`;
        win.appendChild(div);

        div.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            highestZIndex++;
            win.style.zIndex = highestZIndex;

            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = win.offsetWidth;
            const startHeight = win.offsetHeight;
            const startLeft = win.offsetLeft;
            const startTop = win.offsetTop;
            const minWidth = 250;
            const minHeight = 150;

            function doResize(e) {
                if (h.includes('e')) {
                    win.style.width = Math.max(minWidth, startWidth + (e.clientX - startX)) + 'px';
                }
                if (h.includes('s')) {
                    win.style.height = Math.max(minHeight, startHeight + (e.clientY - startY)) + 'px';
                }
                if (h.includes('w')) {
                    const newWidth = Math.max(minWidth, startWidth - (e.clientX - startX));
                    if (newWidth > minWidth) {
                        win.style.width = newWidth + 'px';
                        win.style.left = startLeft + (e.clientX - startX) + 'px';
                    }
                }
                if (h.includes('n')) {
                    const newHeight = Math.max(minHeight, startHeight - (e.clientY - startY));
                    if (newHeight > minHeight) {
                        win.style.height = newHeight + 'px';
                        win.style.top = startTop + (e.clientY - startY) + 'px';
                    }
                }
            }

            function stopResize() {
                document.removeEventListener('mousemove', doResize);
                document.removeEventListener('mouseup', stopResize);
                window.removeEventListener('blur', stopResize);
                saveWindowStates();
            }

            document.addEventListener('mousemove', doResize);
            document.addEventListener('mouseup', stopResize);
            window.addEventListener('blur', stopResize);
        });
    });

    // 3. Dragging
    const titlebar = win.querySelector('.window-titlebar');
    if (titlebar) {
        titlebar.addEventListener('mousedown', (e) => {
            if (e.target.closest('.titlebar-controls')) return; // ignore buttons
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = win.offsetLeft;
            const startTop = win.offsetTop;

            function doDrag(e) {
                if (win.classList.contains('snapped')) {
                    win.classList.remove('snapped');
                    checkMaximizedWindows();
                }

                let newX = startLeft + (e.clientX - startX);
                let newY = startTop + (e.clientY - startY);

                const wsTop = parseInt(document.body.style.getPropertyValue('--workspace-top') || 0);
                const wsLeft = parseInt(document.body.style.getPropertyValue('--workspace-left') || 0);
                const wsWidth = parseInt(document.body.style.getPropertyValue('--workspace-width') || window.innerWidth);
                const wsHeight = parseInt(document.body.style.getPropertyValue('--workspace-height') || window.innerHeight);

                const maxX = wsLeft + wsWidth - 40;
                const maxY = wsTop + wsHeight - 40;
                newX = Math.max(-win.offsetWidth + 40, Math.min(newX, maxX));
                newY = Math.max(0, Math.min(newY, maxY));

                win.style.left = newX + 'px';
                win.style.top = newY + 'px';

                const snapPreview = document.getElementById('snap-preview');
                const edgeThreshold = 20;
                const padding = 0;

                if (snapPreview) {
                    let layout = null;
                    if (e.clientY <= wsTop + edgeThreshold) {
                        layout = 'maximize';
                    } else if (e.clientX <= wsLeft + edgeThreshold) {
                        layout = 'half-left';
                    } else if (e.clientX >= wsLeft + wsWidth - edgeThreshold) {
                        layout = 'half-right';
                    }

                    if (layout) {
                        win.dataset.pendingSnap = layout;
                        snapPreview.classList.remove('hidden');

                        if (layout === 'maximize') {
                            snapPreview.style.left = (wsLeft + padding) + 'px';
                            snapPreview.style.top = (wsTop + padding) + 'px';
                            snapPreview.style.width = (wsWidth - padding * 2) + 'px';
                            snapPreview.style.height = (wsHeight - padding * 2) + 'px';
                        } else if (layout === 'half-left') {
                            snapPreview.style.left = (wsLeft + padding) + 'px';
                            snapPreview.style.top = (wsTop + padding) + 'px';
                            snapPreview.style.width = (wsWidth / 2 - padding * 1.5) + 'px';
                            snapPreview.style.height = (wsHeight - padding * 2) + 'px';
                        } else if (layout === 'half-right') {
                            snapPreview.style.left = (wsLeft + wsWidth / 2 + padding * 0.5) + 'px';
                            snapPreview.style.top = (wsTop + padding) + 'px';
                            snapPreview.style.width = (wsWidth / 2 - padding * 1.5) + 'px';
                            snapPreview.style.height = (wsHeight - padding * 2) + 'px';
                        }
                    } else {
                        win.dataset.pendingSnap = '';
                        snapPreview.classList.add('hidden');
                    }
                }
            }

            function stopDrag() {
                document.removeEventListener('mousemove', doDrag);
                document.removeEventListener('mouseup', stopDrag);
                window.removeEventListener('blur', stopDrag);

                const pendingSnap = win.dataset.pendingSnap;
                if (pendingSnap && typeof applySnapLayout === 'function') {
                    applySnapLayout(win, pendingSnap);
                    win.dataset.pendingSnap = '';
                }
                const snapPreview = document.getElementById('snap-preview');
                if (snapPreview) snapPreview.classList.add('hidden');

                saveWindowStates();
            }

            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', stopDrag);
            window.addEventListener('blur', stopDrag);
        });
    }

    // 4. Snap Layouts Hover
    const maxBtn = win.querySelector('.win-max');
    if (maxBtn) {
        let hoverTimeout;
        maxBtn.addEventListener('mouseenter', (e) => {
            clearTimeout(hoverTimeout);
            const rect = maxBtn.getBoundingClientRect();
            const snapPopup = document.getElementById('snap-layout-popup');
            snapPopup.style.top = (rect.bottom + 5) + 'px';
            snapPopup.style.left = (rect.left - 100) + 'px';
            snapPopup.classList.remove('hidden');
            snapPopup.activeWindow = win;
        });
        maxBtn.addEventListener('mouseleave', () => {
            hoverTimeout = setTimeout(() => {
                const snapPopup = document.getElementById('snap-layout-popup');
                if (snapPopup) snapPopup.classList.add('hidden');
            }, 300);
        });
    }
});

const snapPopup = document.getElementById('snap-layout-popup');
if (snapPopup) {
    snapPopup.addEventListener('mouseenter', () => {
        snapPopup.classList.remove('hidden');
    });
    snapPopup.addEventListener('mouseleave', () => {
        snapPopup.classList.add('hidden');
    });
}

// 5. Handle Snap Layout Clicks
function applySnapLayout(win, layout) {
    if (!win) return;

    // Remove maximized state if snapped
    win.classList.remove('maximized');
    win.classList.add('snapped');
    checkMaximizedWindows();

    const padding = 0;
    const wsTop = parseInt(document.body.style.getPropertyValue('--workspace-top') || 0);
    const wsLeft = parseInt(document.body.style.getPropertyValue('--workspace-left') || 0);
    const wsWidth = parseInt(document.body.style.getPropertyValue('--workspace-width') || window.innerWidth);
    const wsHeight = parseInt(document.body.style.getPropertyValue('--workspace-height') || window.innerHeight);

    if (layout === 'half-left') {
        win.style.left = (wsLeft + padding) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth / 2 - padding * 1.5) + 'px';
        win.style.height = (wsHeight - padding * 2) + 'px';
    } else if (layout === 'half-right') {
        win.style.left = (wsLeft + wsWidth / 2 + padding * 0.5) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth / 2 - padding * 1.5) + 'px';
        win.style.height = (wsHeight - padding * 2) + 'px';
    } else if (layout === 'third-left') {
        win.style.left = (wsLeft + padding) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth / 3 - padding * 1.5) + 'px';
        win.style.height = (wsHeight - padding * 2) + 'px';
    } else if (layout === 'third-center') {
        win.style.left = (wsLeft + wsWidth / 3 + padding * 0.5) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth / 3 - padding * 1.5) + 'px';
        win.style.height = (wsHeight - padding * 2) + 'px';
    } else if (layout === 'third-right') {
        win.style.left = (wsLeft + (wsWidth / 3) * 2 + padding * 0.5) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth / 3 - padding * 1.5) + 'px';
        win.style.height = (wsHeight - padding * 2) + 'px';
    } else if (layout === 'uneven-left') {
        win.style.left = (wsLeft + padding) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth * 0.66 - padding * 1.5) + 'px';
        win.style.height = (wsHeight - padding * 2) + 'px';
    } else if (layout === 'uneven-right') {
        win.style.left = (wsLeft + wsWidth * 0.66 + padding * 0.5) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth * 0.33 - padding * 1.5) + 'px';
        win.style.height = (wsHeight - padding * 2) + 'px';
    } else if (layout === 'quarter-top-left') {
        win.style.left = (wsLeft + padding) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth / 2 - padding * 1.5) + 'px';
        win.style.height = (wsHeight / 2 - padding * 1.5) + 'px';
    } else if (layout === 'quarter-top-right') {
        win.style.left = (wsLeft + wsWidth / 2 + padding * 0.5) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth / 2 - padding * 1.5) + 'px';
        win.style.height = (wsHeight / 2 - padding * 1.5) + 'px';
    } else if (layout === 'quarter-bottom-left') {
        win.style.left = (wsLeft + padding) + 'px';
        win.style.top = (wsTop + wsHeight / 2 + padding * 0.5) + 'px';
        win.style.width = (wsWidth / 2 - padding * 1.5) + 'px';
        win.style.height = (wsHeight / 2 - padding * 1.5) + 'px';
    } else if (layout === 'quarter-bottom-right') {
        win.style.left = (wsLeft + wsWidth / 2 + padding * 0.5) + 'px';
        win.style.top = (wsTop + wsHeight / 2 + padding * 0.5) + 'px';
        win.style.width = (wsWidth / 2 - padding * 1.5) + 'px';
        win.style.height = (wsHeight / 2 - padding * 1.5) + 'px';
    } else if (layout === 'maximize') {
        win.style.left = (wsLeft + padding) + 'px';
        win.style.top = (wsTop + padding) + 'px';
        win.style.width = (wsWidth - padding * 2) + 'px';
        win.style.height = (wsHeight - padding * 2) + 'px';
    }
}

document.querySelectorAll('.snap-zone').forEach(zone => {
    zone.addEventListener('click', (e) => {
        const layout = zone.getAttribute('data-layout');
        const win = snapPopup.activeWindow;
        if (!win) return;

        applySnapLayout(win, layout);
        snapPopup.classList.add('hidden');
        saveWindowStates();
    });
});

// --- 7. Taskbar Enhancements (Start Menu, Drag & Drop, Pin) ---
const startBtn = document.getElementById('start-btn');
const startMenu = document.getElementById('start-menu');

if (startBtn && startMenu) {
    startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startMenu.classList.toggle('hidden');
        startBtn.classList.toggle('active', !startMenu.classList.contains('hidden'));
    });
    document.addEventListener('click', (e) => {
        if (!startMenu.contains(e.target) && e.target !== startBtn) {
            startMenu.classList.add('hidden');
            startBtn.classList.remove('active');
        }
    });

    document.querySelectorAll('.start-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const targetId = item.getAttribute('data-launch');
            const win = document.getElementById(targetId);
            if (win) {
                win.classList.remove('hidden');
                win.classList.remove('minimized');
                highestZIndex++;
                win.style.zIndex = highestZIndex;
                ensureTaskbarIcon(targetId);
                updateTaskbarIcons();
                saveWindowStates();
                if (win.id === 'window-coder' && typeof editor !== 'undefined' && editor && typeof editor.layout === 'function') {
                    editor.layout();
                }
            }
            startMenu.classList.add('hidden');
            startBtn.classList.remove('active');
        });
    });
}

const taskbarApps = document.querySelector('.taskbar-apps');
let draggedIcon = null;

function setupDragAndDrop(icon) {
    icon.setAttribute('draggable', true);

    icon.addEventListener('dragstart', (e) => {
        draggedIcon = icon;
        setTimeout(() => icon.classList.add('dragging'), 0);
    });

    icon.addEventListener('dragend', () => {
        draggedIcon = null;
        icon.classList.remove('dragging');
        document.querySelectorAll('.taskbar-icon').forEach(i => i.classList.remove('drag-over'));
        savePinnedState();
    });

    icon.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (icon === draggedIcon) return;
        icon.classList.add('drag-over');
    });

    icon.addEventListener('dragleave', () => {
        icon.classList.remove('drag-over');
    });

    icon.addEventListener('drop', (e) => {
        e.preventDefault();
        icon.classList.remove('drag-over');
        if (icon !== draggedIcon && draggedIcon) {
            const rect = icon.getBoundingClientRect();
            const midpoint = rect.left + rect.width / 2;
            if (e.clientX < midpoint) {
                taskbarApps.insertBefore(draggedIcon, icon);
            } else {
                taskbarApps.insertBefore(draggedIcon, icon.nextSibling);
            }
        }
    });
}

const taskbarContextMenu = document.getElementById('taskbar-context-menu');
const pinUnpinBtn = document.getElementById('ctx-pin-unpin');
let contextTargetIcon = null;

const DEFAULT_PINNED = ['window-coder', 'window-terminal', 'window-simulator', 'window-settings'];

function getPinnedApps() {
    try {
        const saved = localStorage.getItem('racecar_pinned_apps');
        return saved ? JSON.parse(saved) : DEFAULT_PINNED;
    } catch {
        return DEFAULT_PINNED;
    }
}

function savePinnedState() {
    const currentIcons = Array.from(document.querySelectorAll('.taskbar-icon'))
        .filter(icon => icon.dataset.pinned === 'true')
        .map(icon => icon.getAttribute('data-target'));
    localStorage.setItem('racecar_pinned_apps', JSON.stringify(currentIcons));
}

const pinnedApps = getPinnedApps();

document.querySelectorAll('.taskbar-icon').forEach(icon => {
    const target = icon.getAttribute('data-target');
    if (pinnedApps.includes(target)) {
        icon.dataset.pinned = 'true';
    } else {
        icon.dataset.pinned = 'false';
        const win = document.getElementById(target);
        if (win && win.classList.contains('hidden')) {
            icon.remove();
        }
    }

    setupDragAndDrop(icon);

    icon.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        contextTargetIcon = icon;

        const desktopMenu = document.getElementById('desktop-context-menu');
        if (desktopMenu) desktopMenu.classList.add('hidden');

        const isPinned = icon.dataset.pinned === 'true';
        if (pinUnpinBtn) pinUnpinBtn.textContent = isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar';

        if (taskbarContextMenu) {
            taskbarContextMenu.style.left = e.pageX + 'px';
            taskbarContextMenu.style.top = (e.pageY - 40) + 'px'; // open above taskbar
            taskbarContextMenu.classList.remove('hidden');
        }
    });
});

if (pinUnpinBtn && taskbarContextMenu) {
    pinUnpinBtn.addEventListener('click', () => {
        if (contextTargetIcon) {
            const isPinned = contextTargetIcon.dataset.pinned === 'true';
            contextTargetIcon.dataset.pinned = isPinned ? 'false' : 'true';
            savePinnedState();

            if (contextTargetIcon.dataset.pinned === 'false') {
                const target = contextTargetIcon.getAttribute('data-target');
                const win = document.getElementById(target);
                if (win && win.classList.contains('hidden')) {
                    contextTargetIcon.remove();
                }
            }
        }
        taskbarContextMenu.classList.add('hidden');
    });

    document.addEventListener('click', () => {
        taskbarContextMenu.classList.add('hidden');
    });
}

document.querySelectorAll('.win-close, .win-close-settings').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const win = e.target.closest('.window');
        if (win) {
            const winId = win.id;
            const icon = document.querySelector(`.taskbar-icon[data-target="${winId}"]`);
            if (icon && icon.dataset.pinned === 'false') {
                icon.remove();
            }
        }
    });
});

function ensureTaskbarIcon(targetId) {
    let icon = document.querySelector(`.taskbar-icon[data-target="${targetId}"]`);
    if (!icon) {
        icon = document.createElement('button');
        icon.className = 'taskbar-icon';
        icon.setAttribute('data-target', targetId);
        icon.dataset.pinned = 'false';

        if (targetId === 'window-coder') { icon.title = 'Code Editor'; icon.textContent = '📝'; }
        else if (targetId === 'window-terminal') { icon.title = 'Terminal'; icon.textContent = '💻'; }
        else if (targetId === 'window-simulator') { icon.title = 'Simulator'; icon.textContent = '🏎️'; }
        else if (targetId === 'window-settings') { icon.title = 'Settings'; icon.textContent = '⚙️'; }

        setupDragAndDrop(icon);

        icon.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            contextTargetIcon = icon;
            const desktopMenu = document.getElementById('desktop-context-menu');
            if (desktopMenu) desktopMenu.classList.add('hidden');
            const isPinned = icon.dataset.pinned === 'true';
            if (pinUnpinBtn) pinUnpinBtn.textContent = isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar';
            if (taskbarContextMenu) {
                taskbarContextMenu.style.left = e.pageX + 'px';
                taskbarContextMenu.style.top = (e.pageY - 40) + 'px';
                taskbarContextMenu.classList.remove('hidden');
            }
        });

        icon.addEventListener('click', () => {
            const win = document.getElementById(targetId);
            if (!win) return;
            if (win.classList.contains('hidden')) {
                win.classList.remove('hidden');
                win.classList.remove('minimized');
                win.style.zIndex = ++highestZIndex;
                if (win.id === 'window-coder' && typeof editor !== 'undefined' && editor && typeof editor.layout === 'function') {
                    editor.layout();
                }
            } else if (win.classList.contains('minimized')) {
                win.classList.remove('minimized');
                win.style.zIndex = ++highestZIndex;
                if (win.id === 'window-coder') {
                    // Keep transition:none from minimize, layout synchronously
                    if (typeof editor !== 'undefined' && editor && typeof editor.layout === 'function') {
                        editor.layout();
                    }
                    setTimeout(() => { win.style.transition = ''; }, 150);
                }
            } else {
                if (parseInt(win.style.zIndex || 0) === highestZIndex) {
                    if (win.id === 'window-coder') {
                        win.style.transition = 'none';
                        void win.offsetHeight;
                    }
                    win.classList.add('minimized');
                } else {
                    win.style.zIndex = ++highestZIndex;
                }
            }
            updateTaskbarIcons();
            checkMaximizedWindows();
            saveWindowStates();
        });

        if (taskbarApps) taskbarApps.appendChild(icon);
    }
}

// Reset Window Layout Logic
const resetWindowsBtn = document.getElementById('reset-windows-btn');
if (resetWindowsBtn) {
    resetWindowsBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to reset all window positions?')) {
            localStorage.removeItem('racecar_window_states');

            const defaults = {
                'window-coder': { top: '20px', left: '20px', width: '600px', height: '500px', zIndex: '10', classes: [] },
                'window-terminal': { top: '540px', left: '20px', width: '600px', height: '300px', zIndex: '11', classes: [] },
                'window-simulator': { top: '20px', left: '640px', width: '640px', height: '512px', zIndex: '12', classes: [] },
                'window-settings': { top: '100px', left: '200px', width: '400px', height: '350px', zIndex: '13', classes: ['hidden'] }
            };

            windows.forEach(win => {
                const def = defaults[win.id];
                if (def) {
                    win.style.top = def.top;
                    win.style.left = def.left;
                    win.style.width = def.width;
                    win.style.height = def.height;
                    win.style.zIndex = def.zIndex;
                    win.classList.remove('hidden', 'minimized', 'maximized');
                    def.classes.forEach(c => win.classList.add(c));
                }
            });

            highestZIndex = 20;
            updateTaskbarIcons();
            checkMaximizedWindows();
            saveWindowStates();
        }
    });
}

// Warn on exit if unsaved or unexported
window.addEventListener('beforeunload', (e) => {
    let warn = false;
    if (hasUnsavedChanges) warn = true;
    else if (hasUnexportedData && warnExportToggleVal) warn = true;

    if (warn) {
        e.preventDefault();
        e.returnValue = ''; // Required for modern browsers to show standard dialog
    }
});
