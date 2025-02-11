// stateManager.js
const fs = require('fs');
const stateFile = 'botState.json';

function saveState(state) {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function loadState() {
    if (fs.existsSync(stateFile)) {
        const data = fs.readFileSync(stateFile);
        return JSON.parse(data);
    } else {
        return null;
    }
}

function clearState() {
    if (fs.existsSync(stateFile)) {
        fs.unlinkSync(stateFile);
    }
}

module.exports = { saveState, loadState, clearState };
