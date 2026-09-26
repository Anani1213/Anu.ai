export default async function handler(req, res) {
  // የ POST ጥያቄ መሆኑን ማረጋገጥ
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { message } = req.body;

  // መልእክት ከሌለ ወይም /start ካልሆነ ችላ በል
  if (!message || !message.text || message.text !== '/start') {
    return res.status(200).send('OK');
  }

  const chatId = message.chat.id;
  const token = process.env.TELEGRAM_BOT_TOKEN; // የቦት ቶከንዎ በ Environment Variable ውስጥ መሆን አለበት

  // አዲሱ የእንኳን ደህና መጡ ጽሑፍ (በእንግሊዝኛ)
  const welcomeText = 
    "👋 Welcome to Anu AI Assistant!\n\n" +
    "I am Anu — your intelligent neural assistant.\n\n" +
    "✨ What I can do:\n" +
    "• Answer questions on any topic\n" +
    "• Write and explain code\n" +
    "• Help with analysis & reasoning\n" +
    "• Translate and summarize text\n\n" +
    "👇 To get started, tap the 'Open Anu' (or Menu) button at the bottom left to open the dashboard and begin!";

  try {
    // መልእክቱን ወደ ቴሌግራም መላክ
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: welcomeText,
        // ከዚህ በታች reply_markup የለም። ይህ ማለት በቻት ውስጥ ያሉት በተኖች ይጠፋሉ ማለት ነው።
      }),
    });

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error sending message:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
