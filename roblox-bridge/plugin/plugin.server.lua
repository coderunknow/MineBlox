-- Roblox Bridge Plugin
-- Connects to the local bridge server to execute Luau code on demand.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local SETTING_URL = "RobloxBridge_Url"
local SETTING_TOKEN = "RobloxBridge_Token"

local bridgeUrl = plugin:GetSetting(SETTING_URL) or "http://127.0.0.1:8787"
local bridgeToken = plugin:GetSetting(SETTING_TOKEN) or ""

local toolbar = plugin:CreateToolbar("Roblox Bridge")
local connectBtn = toolbar:CreateButton("Connect", "Connect or disconnect from the bridge", "rbxassetid://10734944444")
local settingsBtn = toolbar:CreateButton("Settings", "Configure bridge URL and Token", "rbxassetid://11295287666")

-- Store active connection state
local sessionId = nil
local isPolling = false
local pollIntervalMs = 1000

local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Float,
    false,
    true,
    300,
    180,
    250,
    150
)
local settingsWidget = plugin:CreateDockWidgetPluginGui("RobloxBridgeSettings", widgetInfo)
settingsWidget.Title = "Bridge Settings"

local uiLayout = Instance.new("UIListLayout")
uiLayout.SortOrder = Enum.SortOrder.LayoutOrder
uiLayout.Padding = UDim.new(0, 5)
uiLayout.Parent = settingsWidget

local function createTextBox(name, labelText, initialValue, order)
    local frame = Instance.new("Frame")
    frame.Size = UDim2.new(1, 0, 0, 40)
    frame.BackgroundTransparency = 1
    frame.LayoutOrder = order
    frame.Parent = settingsWidget

    local label = Instance.new("TextLabel")
    label.Size = UDim2.new(1, 0, 0, 15)
    label.BackgroundTransparency = 1
    label.Text = labelText
    label.TextXAlignment = Enum.TextXAlignment.Left
    label.TextColor3 = Color3.new(1, 1, 1)
    label.Parent = frame

    local textBox = Instance.new("TextBox")
    textBox.Size = UDim2.new(1, 0, 0, 25)
    textBox.Position = UDim2.new(0, 0, 0, 15)
    textBox.Text = initialValue
    textBox.BackgroundColor3 = Color3.fromRGB(40, 40, 40)
    textBox.TextColor3 = Color3.new(1, 1, 1)
    textBox.TextXAlignment = Enum.TextXAlignment.Left
    textBox.ClearTextOnFocus = false
    textBox.Parent = frame
    
    return textBox
end

local urlBox = createTextBox("UrlBox", "Bridge URL", bridgeUrl, 1)
local tokenBox = createTextBox("TokenBox", "Token (optional)", bridgeToken, 2)

local saveBtn = Instance.new("TextButton")
saveBtn.Size = UDim2.new(1, 0, 0, 30)
saveBtn.LayoutOrder = 3
saveBtn.Text = "Save"
saveBtn.BackgroundColor3 = Color3.fromRGB(0, 120, 215)
saveBtn.TextColor3 = Color3.new(1, 1, 1)
saveBtn.Parent = settingsWidget

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(1, 0, 0, 20)
statusLabel.LayoutOrder = 4
statusLabel.BackgroundTransparency = 1
statusLabel.Text = "Disconnected"
statusLabel.TextColor3 = Color3.fromRGB(150, 150, 150)
statusLabel.Parent = settingsWidget

saveBtn.MouseButton1Click:Connect(function()
    bridgeUrl = urlBox.Text
    bridgeToken = tokenBox.Text
    plugin:SetSetting(SETTING_URL, bridgeUrl)
    plugin:SetSetting(SETTING_TOKEN, bridgeToken)
    statusLabel.Text = "Settings saved."
end)

settingsBtn.Click:Connect(function()
    settingsWidget.Enabled = not settingsWidget.Enabled
end)

local function getHeaders()
    local h = { ["Content-Type"] = "application/json" }
    if bridgeToken and bridgeToken ~= "" then
        h["Authorization"] = "Bearer " .. bridgeToken
    end
    return h
end

local function updateStatus(text, active)
    statusLabel.Text = text
    if active then
        statusLabel.TextColor3 = Color3.fromRGB(0, 200, 0)
    else
        statusLabel.TextColor3 = Color3.fromRGB(200, 0, 0)
    end
end

local function disconnect()
    isPolling = false
    sessionId = nil
    updateStatus("Disconnected", false)
end

local function registerSession()
    local url = bridgeUrl:gsub("/+$", "") .. "/api/plugin/register"
    local body = HttpService:JSONEncode({
        name = "Roblox Studio",
        studioVersion = version()
    })
    
    local success, response = pcall(function()
        return HttpService:RequestAsync({
            Url = url,
            Method = "POST",
            Headers = getHeaders(),
            Body = body,
            Timeout = 5
        })
    end)
    
    if not success then
        updateStatus("Failed to connect: " .. tostring(response), false)
        return false
    end
    
    if not response.Success then
        updateStatus("HTTP Error: " .. tostring(response.StatusCode), false)
        return false
    end
    
    local data = HttpService:JSONDecode(response.Body)
    sessionId = data.sessionId
    if data.pollIntervalMs then
        pollIntervalMs = data.pollIntervalMs
    end
    
    updateStatus("Connected", true)
    return true
end

local function reportResult(commandId, resultOk, outputStr, errorStr, duration)
    local url = bridgeUrl:gsub("/+$", "") .. "/api/plugin/result"
    local payload = {
        commandId = commandId,
        sessionId = sessionId,
        ok = resultOk,
        output = outputStr,
        error = errorStr,
        durationMs = duration
    }
    
    pcall(function()
        HttpService:RequestAsync({
            Url = url,
            Method = "POST",
            Headers = getHeaders(),
            Body = HttpService:JSONEncode(payload),
            Timeout = 5
        })
    end)
end

local function executeCommand(cmd)
    local startedAt = os.clock()
    
    if cmd.type == "ping" then
        reportResult(cmd.id, true, "pong", nil, (os.clock() - startedAt) * 1000)
        return
    end
    
    local func, loadErr = loadstring(cmd.code)
    if not func then
        reportResult(cmd.id, false, "", "Syntax Error: " .. tostring(loadErr), (os.clock() - startedAt) * 1000)
        return
    end

    -- Capture output
    local outputCapture = {}
    local function customPrint(...)
        local args = {...}
        local strArgs = {}
        for i, v in ipairs(args) do
            table.insert(strArgs, tostring(v))
        end
        table.insert(outputCapture, table.concat(strArgs, "\t"))
        -- also print to real console
        print(...)
    end
    
    local function customWarn(...)
        local args = {...}
        local strArgs = {}
        for i, v in ipairs(args) do
            table.insert(strArgs, tostring(v))
        end
        table.insert(outputCapture, "[WARN] " .. table.concat(strArgs, "\t"))
        warn(...)
    end
    
    local env = getfenv(func)
    env.print = customPrint
    env.warn = customWarn
    env.plugin = plugin
    setfenv(func, env)
    
    local recording = ChangeHistoryService:TryBeginRecording("BridgeExec_" .. cmd.id)
    
    local success, runErr = pcall(func)
    
    if recording then
        if success then
            ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
        else
            ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
        end
    end
    
    local outStr = table.concat(outputCapture, "\n")
    local duration = (os.clock() - startedAt) * 1000
    
    if success then
        reportResult(cmd.id, true, outStr, nil, duration)
    else
        reportResult(cmd.id, false, outStr, tostring(runErr), duration)
    end
end

local function pollCommands()
    if not isPolling or not sessionId then return end
    
    local url = bridgeUrl:gsub("/+$", "") .. "/api/plugin/poll"
    local payload = HttpService:JSONEncode({ sessionId = sessionId })
    
    local success, response = pcall(function()
        return HttpService:RequestAsync({
            Url = url,
            Method = "POST",
            Headers = getHeaders(),
            Body = payload,
            Timeout = 10
        })
    end)
    
    if success and response.Success then
        local data = HttpService:JSONDecode(response.Body)
        if data.commands then
            for _, cmd in ipairs(data.commands) do
                executeCommand(cmd)
            end
        end
    elseif success and response.StatusCode == 404 then
        -- Session expired on server
        disconnect()
    end
    
    if isPolling then
        task.delay(pollIntervalMs / 1000, pollCommands)
    end
end

connectBtn.Click:Connect(function()
    if isPolling then
        disconnect()
    else
        if registerSession() then
            isPolling = true
            task.spawn(pollCommands)
        end
    end
end)

plugin.Unloading:Connect(function()
    disconnect()
end)
