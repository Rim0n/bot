import dotenv from "dotenv"
import { Client, GatewayIntentBits, Partials, AuditLogEvent, ChannelType, EmbedBuilder } from "discord.js"
import { OpenAI } from "openai"
import { createCanvas, loadImage } from "canvas"
import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
} from "@discordjs/voice"
import ytdl from "ytdl-core"
import ytSearch from "yt-search"
import { spawn } from "child_process"
import { generateDependencyReport } from "@discordjs/voice"

// Load environment variables
dotenv.config()

// Configuration for logging channels
const config = {
  logChannel: "1175765852252020767",
  roleLogChannel: "1175765756533817364",
  welcomeChannel: "1156511265196351508",
  memberCountChannel: "1400463199232327791",
  memberListChannel: "1400463199232327791",
  kickLogChannel: "1400068759749922888",
  voiceLogChannel: "1400069855566106755",
  gptCategoryId: "936894533193572392",
}

// Create Discord client with all necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
})

// Initialize OpenAI for GPT features
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
})

// GPT memory per user
const userConversations = new Map()

// Music bot storage for each guild
const guilds = new Map()

// Predefined songs for music bot
const presetSongs = {
  lofi: "lofi hip hop radio - beats to relax/study to",
  jazz: "smooth jazz instrumental music",
  piano: "relaxing piano music",
  chill: "chill beats to relax",
  minecraft: "minecraft background music",
  classical: "classical music for studying",
  rain: "rain sounds for sleeping",
  nature: "forest sounds relaxing",
  study: "study music concentration",
  rock: "classic rock music",
  pop: "popular music hits",
}

// Initialize guild data for music
function getGuildData(guildId) {
  if (!guilds.has(guildId)) {
    guilds.set(guildId, {
      queue: [],
      player: null,
      connection: null,
      isPlaying: false,
      currentSong: null,
    })
  }
  return guilds.get(guildId)
}

// Create welcome image
async function createWelcomeImage(displayName, avatarURL) {
  const canvas = createCanvas(800, 250)
  const ctx = canvas.getContext("2d")

  ctx.fillStyle = "#23272A"
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const avatar = await loadImage(avatarURL)
  ctx.save()
  ctx.beginPath()
  ctx.arc(125, 125, 100, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  ctx.drawImage(avatar, 25, 25, 200, 200)
  ctx.restore()

  ctx.fillStyle = "#FFFFFF"
  ctx.font = "bold 32px Sans"
  ctx.fillText("Welcome,", 250, 100)
  ctx.fillText(displayName, 250, 160)

  return canvas.toBuffer("image/png")
}

// Create GPT channel for user
async function createPrivateGptChannel(guild, member) {
  const safeUsername = member.user.username.toLowerCase().replace(/[^a-z0-9]/g, "")
  const channelName = `gpt-${safeUsername}`

  const existing = guild.channels.cache.find((c) => c.name === channelName && c.type === ChannelType.GuildText)
  if (existing) return

  try {
    const gptCategory = guild.channels.cache.get(config.gptCategoryId)
    const categoryChannelCount = guild.channels.cache.filter((c) => c.parentId === config.gptCategoryId).size
    const isCategoryFull = categoryChannelCount >= 50

    await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: isCategoryFull ? undefined : config.gptCategoryId,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: ["ViewChannel"],
        },
        {
          id: member.id,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        },
        {
          id: client.user.id,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        },
      ],
    })
  } catch (err) {
    console.error(`❌ Failed to create GPT channel for ${member.user.username}:`, err)
  }
}

// Update member count and list
async function updateMemberList(client) {
  try {
    const countChannel = client.channels.cache.get(config.memberCountChannel)
    const listChannel = client.channels.cache.get(config.memberListChannel)
    if (!countChannel || !listChannel) return

    const guild = countChannel.guild
    const members = await guild.members.fetch()
    const humanMembers = members.filter((m) => !m.user.bot)

    await countChannel.setName(`Members: ${humanMembers.size}`)

    const usernames = [...humanMembers.values()]
      .sort((a, b) => {
        if (!a.joinedTimestamp || !b.joinedTimestamp) return 0
        return a.joinedTimestamp - b.joinedTimestamp
      })
      .map((member, i) => `${i + 1}. ${member.user.username} (${member.displayName})`)
      .join("\n")

    const messages = await listChannel.messages.fetch({ limit: 10 })
    const botMsg = messages.find((msg) => msg.author.id === client.user.id)

    if (botMsg) {
      await botMsg.edit({ content: usernames })
    } else {
      await listChannel.send({ content: usernames })
    }
  } catch (err) {
    console.error("❌ Error in updateMemberList:", err)
  }
}

// Create audio stream for music with better error handling
async function createAudioStream(videoUrl) {
  console.log("Creating audio stream...")

  try {
    let stream

    try {
      const ytDlpProcess = spawn("yt-dlp", [
        "--extract-audio",
        "--audio-format",
        "best",
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        "--output",
        "-",
        videoUrl,
      ])

      const ffmpegProcess = spawn(
        "ffmpeg",
        ["-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "pipe:1"],
        {
          stdio: ["pipe", "pipe", "ignore"],
        },
      )

      ytDlpProcess.stdout.pipe(ffmpegProcess.stdin)

      ytDlpProcess.on("error", () => ffmpegProcess.kill())
      ffmpegProcess.on("error", () => ytDlpProcess.kill())

      stream = ffmpegProcess.stdout
    } catch (ytDlpError) {
      console.log("yt-dlp failed, falling back to ytdl-core...")
      stream = ytdl(videoUrl, {
        filter: "audioonly",
        quality: "highestaudio",
        highWaterMark: 1 << 25,
      })
    }

    return stream
  } catch (error) {
    throw new Error(`Failed to create audio stream: ${error.message}`)
  }
}

// Play next song in queue
async function playNext(guildId, textChannel) {
  const guildData = getGuildData(guildId)

  if (guildData.queue.length === 0) {
    guildData.isPlaying = false
    guildData.currentSong = null

    setTimeout(
      () => {
        const data = getGuildData(guildId)
        if (!data.isPlaying && data.connection) {
          data.connection.destroy()
          data.connection = null
          textChannel.send("🔌 Disconnected due to inactivity.")
        }
      },
      5 * 60 * 1000,
    )

    return
  }

  const song = guildData.queue.shift()
  guildData.currentSong = song
  guildData.isPlaying = true

  try {
    const stream = await createAudioStream(song.url)
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
    })

    guildData.player.play(resource)

    const embed = new EmbedBuilder()
      .setColor("#00FF00")
      .setTitle("🎵 Now Playing")
      .setDescription(`**${song.title}**`)
      .addFields(
        { name: "🎤 Requested by", value: song.requester, inline: true },
        { name: "📋 Queue", value: `${guildData.queue.length} songs`, inline: true },
      )
      .setURL(song.url)
      .setTimestamp()

    textChannel.send({ embeds: [embed] })
  } catch (error) {
    console.error("Error playing song:", error)
    textChannel.send(`❌ Error playing: ${song.title}`)
    playNext(guildId, textChannel)
  }
}

// Search for song
async function searchSong(query) {
  if (presetSongs[query.toLowerCase()]) {
    query = presetSongs[query.toLowerCase()]
  }

  const searchResults = await ytSearch(query)

  if (!searchResults.videos.length) {
    throw new Error("No songs found")
  }

  const goodVideos = searchResults.videos.filter((video) => {
    const duration = video.duration?.seconds || 0
    const title = video.title.toLowerCase()

    return (
      duration > 30 && duration < 1800 && !title.includes("#shorts") && !title.includes("live") && video.views > 1000
    )
  })

  const selectedVideo = goodVideos.length > 0 ? goodVideos[0] : searchResults.videos[0]

  return {
    title: selectedVideo.title,
    url: selectedVideo.url,
    duration: selectedVideo.duration?.timestamp || "Unknown",
  }
}

function checkVoiceDependencies() {
  try {
    const report = generateDependencyReport()
    console.log("🔍 Voice dependency report:")
    console.log(report)

    // Check if we have a valid encryption package
    if (!report.includes("✅") || report.includes("❌")) {
      console.warn("⚠️  Some voice dependencies may be missing. Music features might not work properly.")
      console.warn("💡 Run: npm install sodium libsodium-wrappers tweetnacl")
    }
  } catch (error) {
    console.error("❌ Error checking voice dependencies:", error.message)
  }
}

// Bot ready event with dependency check
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`)

  checkVoiceDependencies()

  console.log("🎵 Music features enabled")
  console.log("🤖 GPT integration enabled")
  console.log("📊 Logging features enabled")

  client.user.setActivity("🎵 !help for commands | GPT channels available", { type: 2 })

  const guild = client.guilds.cache.first()
  if (guild) {
    const members = await guild.members.fetch()
    for (const member of members.values()) {
      if (!member.user.bot) {
        await createPrivateGptChannel(guild, member)
      }
    }
  }
  updateMemberList(client)
})

// Member join event
client.on("guildMemberAdd", async (member) => {
  const channel = client.channels.cache.get(config.welcomeChannel)
  if (channel) {
    const image = await createWelcomeImage(member.displayName, member.user.displayAvatarURL({ extension: "png" }))
    channel.send({
      content: `🎉 Welcome to the server, **${member.displayName}**!`,
      files: [{ attachment: image, name: "welcome.png" }],
    })
  }

  await createPrivateGptChannel(member.guild, member)
  updateMemberList(client)
})

// Member leave event
client.on("guildMemberRemove", async (member) => {
  const kickLogChannel = client.channels.cache.get(config.kickLogChannel)

  try {
    const audit = await member.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.MemberKick,
    })
    const kick = audit.entries.first()

    if (kick && kick.target.id === member.id && Date.now() - kick.createdTimestamp < 5000) {
      kickLogChannel?.send(`👢 **${member.user.tag}** was kicked by **${kick.executor.tag}**.`)
    } else {
      kickLogChannel?.send(`🚪 **${member.user.tag}** left the server.`)
    }

    const safeUsername = member.user.username.toLowerCase().replace(/[^a-z0-9]/g, "")
    const gptChannelName = `gpt-${safeUsername}`
    const gptChannel = member.guild.channels.cache.find((c) => c.name === gptChannelName)
    if (gptChannel) await gptChannel.delete()

    updateMemberList(client)
  } catch (error) {
    console.error("❌ Error handling member remove:", error)
    updateMemberList(client)
  }
})

// Message delete logging
client.on("messageDelete", async (message) => {
  const channel = client.channels.cache.get(config.logChannel)
  if (channel && !message.partial && message.author) {
    channel.send(`🗑️ **${message.author.tag}** deleted a message: ${message.content}`)
  }
})

// Message edit logging
client.on("messageUpdate", async (oldMessage, newMessage) => {
  const channel = client.channels.cache.get(config.logChannel)
  if (channel && !oldMessage.partial && !newMessage.partial && oldMessage.content !== newMessage.content) {
    channel.send(`✏️ **${newMessage.author.tag}** edited: ${newMessage.content}`)
  }
})

// Role change logging
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const roleLog = client.channels.cache.get(config.roleLogChannel)
  if (!roleLog) return

  const addedRoles = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id))
  const removedRoles = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id))

  for (const role of addedRoles.values()) {
    const audit = await newMember.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberRoleUpdate })
    const entry = audit.entries.first()
    const executor = entry?.executor?.tag || "Unknown"
    roleLog.send(`✅ **${newMember.user.tag}** was given the role **${role.name}** by **${executor}**`)
  }

  for (const role of removedRoles.values()) {
    const audit = await newMember.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberRoleUpdate })
    const entry = audit.entries.first()
    const executor = entry?.executor?.tag || "Unknown"
    roleLog.send(`❌ **${newMember.user.tag}** lost the role **${role.name}** by **${executor}**`)
  }
})

// Voice channel logging
client.on("voiceStateUpdate", async (oldState, newState) => {
  const channel = client.channels.cache.get(config.voiceLogChannel)
  if (!channel) return

  const user = newState.member.user.tag
  const now = Date.now()

  if (!oldState.channel && newState.channel) {
    newState.member.joinedAtTimestamp = now
    channel.send(`🔊 **${user}** joined voice channel: **${newState.channel.name}**`)
  } else if (oldState.channel && !newState.channel) {
    const joined = oldState.member.joinedAtTimestamp || now
    const duration = Math.floor((now - joined) / 1000)
    channel.send(`📴 **${user}** left voice channel: **${oldState.channel.name}** (connected ${duration} sec)`)
  } else if (oldState.channelId !== newState.channelId) {
    channel.send(`➡️ **${user}** moved from **${oldState.channel.name}** to **${newState.channel.name}**`)
  }

  // Clean up music bot when bot is disconnected
  if (oldState.member?.user.bot && oldState.channelId && !newState.channelId) {
    const guildData = getGuildData(oldState.guild.id)
    guildData.connection = null
    guildData.player = null
    guildData.isPlaying = false
    guildData.queue = []
    guildData.currentSong = null
  }
})

// Main message handler
client.on("messageCreate", async (message) => {
  if (message.author.bot) return

  // Help command
  if (message.content === "!help") {
    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("🤖 Combined Bot Commands")
      .setDescription("Complete list of available commands:")
      .addFields(
        {
          name: "🎵 Music Commands",
          value:
            "`!p <song>` - Play/add to queue\n`!skip` - Skip current song\n`!stop` - Stop and clear queue\n`!queue` - Show current queue\n`!np` - Show now playing",
          inline: false,
        },
        {
          name: "🎯 Quick Songs",
          value:
            "`!p lofi` • `!p jazz` • `!p piano` • `!p chill`\n`!p minecraft` • `!p classical` • `!p rock` • `!p pop`",
          inline: false,
        },
        {
          name: "🤖 GPT Features",
          value: "Use your private `gpt-username` channel for AI conversations\nMemory is maintained per user",
          inline: false,
        },
        { name: "🔧 Other", value: "`!help` - Show this help\n`!ping` - Check bot latency", inline: false },
      )
      .setFooter({ text: "Bot includes logging, welcome messages, and member management" })
      .setTimestamp()

    message.reply({ embeds: [embed] })
    return
  }

  // Ping command
  if (message.content === "!ping") {
    const ping = Date.now() - message.createdTimestamp
    message.reply(`🏓 Pong! Latency: ${ping}ms | API: ${Math.round(client.ws.ping)}ms`)
    return
  }

  // Music play command with better error handling
  if (message.content.startsWith("!p ")) {
    const query = message.content.slice(3).trim()
    if (!query) {
      return message.reply("❌ Please provide a song name! Try `!p lofi`")
    }

    const voiceChannel = message.member?.voice?.channel
    if (!voiceChannel) {
      return message.reply("❌ You need to be in a voice channel!")
    }

    const permissions = voiceChannel.permissionsFor(message.client.user)
    if (!permissions.has("Connect") || !permissions.has("Speak")) {
      return message.reply("❌ I need permissions to connect and speak!")
    }

    const guildData = getGuildData(message.guild.id)

    try {
      const loadingMsg = await message.reply("🔍 Searching...")

      const song = await searchSong(query)
      song.requester = message.author.toString()

      guildData.queue.push(song)

      if (!guildData.connection) {
        guildData.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false,
        })

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10000)

          guildData.connection.on(VoiceConnectionStatus.Ready, () => {
            clearTimeout(timeout)
            resolve()
          })

          guildData.connection.on(VoiceConnectionStatus.Disconnected, () => {
            clearTimeout(timeout)
            guildData.connection = null
            guildData.player = null
            guildData.isPlaying = false
            guildData.queue = []
          })
        })
      }

      if (!guildData.player) {
        guildData.player = createAudioPlayer()
        guildData.connection.subscribe(guildData.player)

        guildData.player.on(AudioPlayerStatus.Playing, () => {
          console.log("🎵 Playing audio")
        })

        guildData.player.on(AudioPlayerStatus.Idle, () => {
          console.log("⏸️ Audio finished")
          playNext(message.guild.id, message.channel)
        })

        guildData.player.on("error", (error) => {
          console.error("Player error:", error)
          if (error.message.includes("encryption package")) {
            message.channel.send(
              "❌ **Music Error**: Missing encryption package! Please install sodium: `npm install sodium`",
            )
          } else {
            message.channel.send(`❌ **Playback Error**: ${error.message}`)
          }
          playNext(message.guild.id, message.channel)
        })
      }

      if (guildData.isPlaying) {
        const embed = new EmbedBuilder()
          .setColor("#FFA500")
          .setTitle("📋 Added to Queue")
          .setDescription(`**${song.title}**`)
          .addFields(
            { name: "🎤 Requested by", value: song.requester, inline: true },
            { name: "📍 Position", value: `${guildData.queue.length}`, inline: true },
            { name: "⏱️ Duration", value: song.duration, inline: true },
          )
          .setURL(song.url)
          .setTimestamp()

        await loadingMsg.edit({ content: "", embeds: [embed] })
      } else {
        await loadingMsg.edit("🎵 Starting playback...")
        playNext(message.guild.id, message.channel)
      }
    } catch (error) {
      console.error("Play command error:", error)
      if (error.message.includes("encryption package")) {
        message.reply(
          "❌ **Setup Required**: Missing encryption package! Run `npm install sodium` to enable music features.",
        )
      } else {
        message.reply("❌ Could not play that song. Try `!p lofi` or `!help`")
      }
    }
    return
  }

  // Music skip command
  if (message.content === "!skip") {
    const guildData = getGuildData(message.guild.id)

    if (!guildData.isPlaying) {
      return message.reply("❌ Nothing is playing!")
    }

    guildData.player.stop()
    message.reply("⏭️ Skipped!")
    return
  }

  // Music stop command
  if (message.content === "!stop") {
    const guildData = getGuildData(message.guild.id)

    if (!guildData.connection) {
      return message.reply("❌ Not connected to voice!")
    }

    guildData.queue = []
    guildData.isPlaying = false
    guildData.currentSong = null

    if (guildData.player) {
      guildData.player.stop()
    }

    guildData.connection.destroy()
    guildData.connection = null
    guildData.player = null

    message.reply("⏹️ Stopped and disconnected!")
    return
  }

  // Music queue command
  if (message.content === "!queue" || message.content === "!q") {
    const guildData = getGuildData(message.guild.id)

    if (!guildData.currentSong && guildData.queue.length === 0) {
      return message.reply("📋 Queue is empty!")
    }

    let queueText = ""

    if (guildData.currentSong) {
      queueText += `**🎵 Now Playing:**\n${guildData.currentSong.title}\n\n`
    }

    if (guildData.queue.length > 0) {
      queueText += "**📋 Up Next:**\n"
      guildData.queue.slice(0, 10).forEach((song, index) => {
        queueText += `${index + 1}. ${song.title}\n`
      })

      if (guildData.queue.length > 10) {
        queueText += `\n... and ${guildData.queue.length - 10} more songs`
      }
    }

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("📋 Music Queue")
      .setDescription(queueText)
      .setFooter({ text: `Total: ${guildData.queue.length} songs in queue` })
      .setTimestamp()

    message.reply({ embeds: [embed] })
    return
  }

  // Now playing command
  if (message.content === "!np") {
    const guildData = getGuildData(message.guild.id)

    if (!guildData.currentSong) {
      return message.reply("❌ Nothing is playing!")
    }

    const embed = new EmbedBuilder()
      .setColor("#00FF00")
      .setTitle("🎵 Now Playing")
      .setDescription(`**${guildData.currentSong.title}**`)
      .addFields(
        { name: "🎤 Requested by", value: guildData.currentSong.requester, inline: true },
        { name: "📋 Queue", value: `${guildData.queue.length} songs`, inline: true },
      )
      .setURL(guildData.currentSong.url)
      .setTimestamp()

    message.reply({ embeds: [embed] })
    return
  }

  // GPT chat in private channels
  const isGptChannel = message.channel.name?.startsWith("gpt-")
  if (isGptChannel) {
    try {
      const userId = message.author.id
      if (!userConversations.has(userId)) {
        userConversations.set(userId, [])
      }

      const conversation = userConversations.get(userId)
      conversation.push({ role: "user", content: message.content })

      const trimmed = conversation.slice(-20)

      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: trimmed,
      })

      const reply = completion.choices[0].message.content
      message.reply(reply)

      trimmed.push({ role: "assistant", content: reply })
      userConversations.set(userId, trimmed)
    } catch (error) {
      console.error("ChatGPT error:", error)
      message.reply("❌ Error getting response from ChatGPT.")
    }
  }
})

// Error handling
client.on("error", console.error)
process.on("unhandledRejection", console.error)

// Login
const token = process.env.DISCORD_TOKEN
if (!token) {
  console.error("❌ DISCORD_TOKEN not found in .env file!")
  process.exit(1)
}

console.log("🚀 Starting Combined Discord Bot...")
console.log("💡 Features: Music, GPT, Logging, Welcome messages, Member management")
client.login(token)
