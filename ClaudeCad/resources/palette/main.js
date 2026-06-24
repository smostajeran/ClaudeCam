/* ClaudeCad palette front-end.
 * Sends actions to Fusion via adsk.fusionSendData and receives updates through
 * window.fusionJavaScriptHandler.handle(action, data).
 */
(function () {
    "use strict";

    var messagesEl = document.getElementById("messages");
    var inputEl = document.getElementById("input");
    var sendBtn = document.getElementById("sendBtn");
    var statusEl = document.getElementById("status");
    var composer = document.getElementById("composer");
    var approveBtn = document.getElementById("approveBtn");
    var discardBtn = document.getElementById("discardBtn");
    var settingsBtn = document.getElementById("settingsBtn");
    var settingsEl = document.getElementById("settings");
    var apiKeyEl = document.getElementById("apiKey");
    var keyHintEl = document.getElementById("keyHint");
    var saveKeyBtn = document.getElementById("saveKeyBtn");
    var closeSettingsBtn = document.getElementById("closeSettingsBtn");
    var chatSelect = document.getElementById("chatSelect");
    var newChatBtn = document.getElementById("newChatBtn");
    var workingEl = document.getElementById("working");
    var workingTextEl = document.getElementById("workingText");
    var versionEl = document.getElementById("version");
    var versionSettingsEl = document.getElementById("versionSettings");
    var updateBtn = document.getElementById("updateBtn");
    var ghTokenEl = document.getElementById("ghToken");
    var saveTokenBtn = document.getElementById("saveTokenBtn");
    var approvalEl = document.getElementById("approval");
    var approvePlanBtn = document.getElementById("approvePlanBtn");
    var rejectPlanBtn = document.getElementById("rejectPlanBtn");

    var busy = false;
    var hasKey = false;

    function openSettings() {
        settingsEl.classList.remove("hidden");
        apiKeyEl.focus();
    }

    function closeSettings() {
        settingsEl.classList.add("hidden");
        apiKeyEl.value = "";
    }

    function sendData(action, payload) {
        try {
            adsk.fusionSendData(action, JSON.stringify(payload || {}));
        } catch (e) {
            // Fusion not available (e.g. opened outside the host) — ignore.
        }
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    // Inline formatting on an already-escaped string: bold (**x**) and code (`x`).
    // Single * and _ are intentionally left alone so expressions like "2 * width"
    // and parameter names like "back_thickness" aren't mangled into italics.
    function inlineMd(s) {
        var parts = s.split(/(`[^`]+`)/g);
        for (var i = 0; i < parts.length; i++) {
            if (i % 2 === 1) {
                parts[i] = "<code>" + parts[i].slice(1, -1) + "</code>";
            } else {
                parts[i] = parts[i].replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
            }
        }
        return parts.join("");
    }

    function renderBlocks(text) {
        var lines = text.split("\n");
        var out = "";
        var listType = null;
        function closeList() {
            if (listType) { out += "</" + listType + ">"; listType = null; }
        }
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/\s+$/, "");
            var h = /^(#{1,6})\s+(.*)$/.exec(line);
            var ul = /^\s*[-*]\s+(.*)$/.exec(line);
            var ol = /^\s*\d+\.\s+(.*)$/.exec(line);
            if (h) {
                closeList();
                out += '<div class="md-h">' + inlineMd(h[2]) + "</div>";
            } else if (ul) {
                if (listType !== "ul") { closeList(); out += "<ul>"; listType = "ul"; }
                out += "<li>" + inlineMd(ul[1]) + "</li>";
            } else if (ol) {
                if (listType !== "ol") { closeList(); out += "<ol>"; listType = "ol"; }
                out += "<li>" + inlineMd(ol[1]) + "</li>";
            } else if (line === "") {
                closeList();
            } else {
                closeList();
                out += "<div>" + inlineMd(line) + "</div>";
            }
        }
        closeList();
        return out;
    }

    // Render a safe subset of Markdown to HTML. Input is escaped first, so the
    // output never contains caller-supplied tags.
    function renderMarkdown(text) {
        var escaped = escapeHtml(text);
        var chunks = escaped.split(/```/);
        var html = "";
        for (var i = 0; i < chunks.length; i++) {
            if (i % 2 === 1) {
                // Fenced code block; drop an optional language tag on the first line.
                var code = chunks[i].replace(/^[^\n]*\n/, function (first) {
                    return /^[A-Za-z0-9_+-]*\s*\n$/.test(first) ? "" : first;
                });
                code = code.replace(/^\n+/, "").replace(/\n+$/, "");
                html += "<pre><code>" + code + "</code></pre>";
            } else {
                html += renderBlocks(chunks[i]);
            }
        }
        return html;
    }

    function addMessage(role, text) {
        var el = document.createElement("div");
        el.className = "msg " + role;
        if (role === "user") {
            el.textContent = text;  // user text is plain; don't interpret markdown
        } else {
            el.innerHTML = renderMarkdown(text);
        }
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setStatus(isBusy, text) {
        busy = isBusy;
        var label = text || (isBusy ? "Working…" : "");
        statusEl.textContent = isBusy ? label : "";
        workingTextEl.textContent = label || "Working…";
        workingEl.classList.toggle("hidden", !isBusy);
        sendBtn.disabled = isBusy;
        approveBtn.disabled = isBusy;
        if (isBusy) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    function renderChats(chats) {
        chatSelect.innerHTML = "";
        (chats || []).forEach(function (c) {
            var opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.title;
            if (c.active) {
                opt.selected = true;
            }
            chatSelect.appendChild(opt);
        });
    }

    function submit(text) {
        var value = (text !== undefined ? text : inputEl.value).trim();
        if (!value || busy) {
            return;
        }
        // Python echoes the user message back (so it lands in this chat's history),
        // so we don't render it optimistically here.
        sendData("send", { text: value });
        inputEl.value = "";
    }

    composer.addEventListener("submit", function (e) {
        e.preventDefault();
        submit();
    });

    inputEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    });

    approveBtn.addEventListener("click", function () {
        submit("I approve the design.");
    });

    discardBtn.addEventListener("click", function () {
        if (window.confirm("Discard all work created in this session and start over?")) {
            sendData("discard", {});
        }
    });

    newChatBtn.addEventListener("click", function () {
        sendData("new_chat", {});
    });

    function setApproval(pending) {
        approvalEl.classList.toggle("hidden", !pending);
    }

    approvePlanBtn.addEventListener("click", function () {
        setApproval(false);
        sendData("approve_plan", {});
    });

    rejectPlanBtn.addEventListener("click", function () {
        setApproval(false);
        sendData("reject_plan", {});
    });

    chatSelect.addEventListener("change", function () {
        sendData("switch_chat", { id: chatSelect.value });
    });

    settingsBtn.addEventListener("click", function () {
        if (settingsEl.classList.contains("hidden")) {
            openSettings();
        } else {
            closeSettings();
        }
    });

    closeSettingsBtn.addEventListener("click", closeSettings);

    updateBtn.addEventListener("click", function () {
        sendData("update", {});
    });

    saveTokenBtn.addEventListener("click", function () {
        var token = ghTokenEl.value.trim();
        if (!token) {
            return;
        }
        sendData("save_token", { token: token });
        ghTokenEl.value = "";
    });

    saveKeyBtn.addEventListener("click", function () {
        var key = apiKeyEl.value.trim();
        if (!key) {
            return;
        }
        sendData("save_key", { key: key });
        closeSettings();
    });

    // Receive messages from the Python add-in.
    window.fusionJavaScriptHandler = {
        handle: function (action, data) {
            var d = {};
            try {
                d = data ? JSON.parse(data) : {};
            } catch (e) {
                d = {};
            }
            switch (action) {
                case "message":
                    addMessage(d.role || "system", d.text || "");
                    break;
                case "status":
                    setStatus(!!d.busy, d.text || "");
                    break;
                case "reset":
                    messagesEl.innerHTML = "";
                    setStatus(false, "");
                    setApproval(false);
                    break;
                case "chats":
                    renderChats(d.chats);
                    break;
                case "approval":
                    setApproval(!!d.pending);
                    break;
                case "config":
                    hasKey = !!d.has_key;
                    if (d.version) {
                        versionEl.textContent = "v" + d.version;
                        versionSettingsEl.textContent = "v" + d.version;
                    }
                    if (d.env) {
                        keyHintEl.textContent = "An API key is currently set via the ANTHROPIC_API_KEY environment variable, which takes precedence over a saved key.";
                    } else {
                        keyHintEl.innerHTML = "Stored locally in <code>~/.claudecad/config.json</code> (owner-readable only).";
                    }
                    if (!hasKey) {
                        openSettings();
                    } else {
                        closeSettings();
                    }
                    break;
            }
            return "OK";
        }
    };

    // Tell the add-in the palette is ready.
    sendData("ready", {});
})();
