return (
  <div className={`${isDarkMode ? "bg-gray-900 text-white" : "bg-gray-100 text-black"} min-h-screen w-full flex items-center justify-center`}>
    <Head>
      <title>Debt Advisor Chat</title>
    </Head>

    <div className="w-full max-w-2xl p-4 flex flex-col justify-between min-h-[80vh]">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Debt Advisor</h1>
        <div className="flex space-x-2">
          <select
            className="border px-2 py-1 rounded text-sm bg-white text-black"
            value={selectedLang}
            onChange={(e) => setSelectedLang(e.target.value)}
          >
            <option value="English">English</option>
            <option value="Spanish">Spanish</option>
            <option value="Polish">Polish</option>
            <option value="French">French</option>
            <option value="German">German</option>
            <option value="Portuguese">Portuguese</option>
            <option value="Italian">Italian</option>
            <option value="Romanian">Romanian</option>
          </select>
          <button
            className="px-4 py-1 border rounded text-sm"
            onClick={() => setIsDarkMode(!isDarkMode)}
          >
            {isDarkMode ? "Light Mode" : "Dark Mode"}
          </button>
        </div>
      </div>

      <div className="border rounded-lg p-4 space-y-4 bg-white dark:bg-gray-800 flex-1 overflow-y-auto">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-xs md:max-w-md px-4 py-2 rounded-2xl shadow-sm whitespace-pre-line
              ${msg.sender === "user"
                ? "bg-blue-600 text-white rounded-br-none"
                : "bg-gray-200 text-black dark:bg-gray-700 dark:text-white rounded-bl-none"}`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {isBotTyping && (
          <div className="flex justify-start">
            <div className="bg-gray-200 dark:bg-gray-700 text-black dark:text-white px-4 py-2 rounded-2xl shadow-sm">
              Typing...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="mt-4 flex items-center space-x-2">
        <input
          type="text"
          className="flex-1 p-2 border rounded focus:outline-none dark:bg-gray-800 dark:text-white"
          placeholder="Type your message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="bg-blue-600 text-white px-4 py-2 rounded"
          onClick={handleSend}
        >
          Send
        </button>
      </div>
    </div>
  </div>
);
