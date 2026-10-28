registerRoute('/ai', async (params, content) => {
  content.innerHTML = `
    <div class="page-header"><div><h1>Ask AI</h1><p class="sub">Ask questions about hospital operations — answered directly from hospital records</p></div></div>
    <div class="ai-chat-wrap">
      <div class="ai-suggestions" id="ai-suggestions">
        ${[
          'How many beds are available?', 'How many beds are available on Floor 1?', 'Which beds are vacant?',
          'What is our current bed occupancy?', 'Which patients are currently admitted?', 'Which admitted patients have pending lab reports?',
          'Which surgeries were performed this month?'
        ].map(q => `<div class="ai-suggestion-chip">${esc(q)}</div>`).join('')}
      </div>
      <div class="ai-messages" id="ai-messages">
        <div class="ai-msg ai">Hello ${esc(Api.user.name.split(' ')[0])}, I'm Ask AI. I can answer questions using the hospital's own records — bed availability, admitted patients, lab status, surgeries, and more. I'll never make up information; if I can't find something in the records, I'll tell you.</div>
      </div>
      <div class="ai-input-bar">
        <input type="text" id="ai-input" placeholder="Ask a question about the hospital..." style="flex:1">
        <button class="btn btn-primary" id="ai-send">${Icon.send} Ask</button>
      </div>
    </div>
  `;

  const messages = qs('#ai-messages');
  const input = qs('#ai-input');

  function addMsg(text, who) {
    const msg = el(`<div class="ai-msg ${who}">${esc(text)}</div>`);
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  async function send(question) {
    if (!question.trim()) return;
    addMsg(question, 'user');
    input.value = '';
    const thinking = el(`<div class="ai-msg ai">Looking that up...</div>`);
    messages.appendChild(thinking);
    messages.scrollTop = messages.scrollHeight;
    try {
      const res = await Api.post('/ai/ask', { question });
      thinking.textContent = res.answer;
    } catch (e) {
      thinking.textContent = e.message || "I couldn't process that question.";
    }
  }

  qs('#ai-send').onclick = () => send(input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(input.value); });
  qsa('.ai-suggestion-chip').forEach(chip => { chip.onclick = () => send(chip.textContent); });
});
