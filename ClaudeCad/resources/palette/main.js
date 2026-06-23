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

    var busy = false;

    function sendData(action, payload) {
        try {
            adsk.fusionSendData(action, JSON.stringify(payload || {}));
        } catch (e) {
            // Fusion not available (e.g. opened outside the host) — ignore.
        }
    }

    function addMessage(role, text) {
        var el = document.createElement("div");
        el.className = "msg " + role;
        el.textContent = text;
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setStatus(isBusy, text) {
        busy = isBusy;
        statusEl.textContent = text || (isBusy ? "Working…" : "");
        sendBtn.disabled = isBusy;
        approveBtn.disabled = isBusy;
    }

    function submit(text) {
        var value = (text !== undefined ? text : inputEl.value).trim();
        if (!value || busy) {
            return;
        }
        addMessage("user", value);
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
                case "assistant":
                    addMessage("assistant", d.text || "");
                    break;
                case "system":
                    addMessage("system", d.text || "");
                    break;
                case "status":
                    setStatus(!!d.busy, d.text || "");
                    break;
                case "reset":
                    messagesEl.innerHTML = "";
                    setStatus(false, "");
                    break;
            }
            return "OK";
        }
    };

    // Tell the add-in the palette is ready for its greeting.
    sendData("ready", {});
})();
