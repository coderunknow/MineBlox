'use strict';

const fs = require('node:fs');
const path = require('node:path');

function encodeXmlString(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function build() {
  const luaPath = path.join(__dirname, 'plugin.server.lua');
  const outPath = path.join(__dirname, 'roblox-bridge.rbxmx');
  
  const luaCode = fs.readFileSync(luaPath, 'utf8');
  
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<roblox version="4">
  <Item class="Script" referent="0">
    <Properties>
      <string name="Name">RobloxBridge</string>
      <token name="RunContext">0</token>
      <string name="Source"><![CDATA[${luaCode.replace(/]]>/g, ']]>]]><![CDATA[>')}]]></string>
    </Properties>
  </Item>
</roblox>`;

  fs.writeFileSync(outPath, xml, 'utf8');
  console.log(`[build:plugin] Built ${outPath} (${Buffer.byteLength(xml)} bytes)`);
}

if (require.main === module) {
  build();
}

module.exports = { build };
