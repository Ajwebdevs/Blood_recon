require('dotenv').config();
import { Telegraf } from 'telegraf';
import express from 'express';
import { json } from 'body-parser';
import { post } from 'axios';

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const HYGRAPH_API = process.env.HYGRAPH_API_URL;
const HYGRAPH_API_TOKEN = process.env.HYGRAPH_API_TOKEN;

const requestHygraph = async (query, variables) => {
  try {
    const response = await post(
      HYGRAPH_API,
      { query, variables },
      { headers: { Authorization: `Bearer ${HYGRAPH_API_TOKEN}` } }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching from Hygraph:", error.response?.data || error);
  }
};

// Webhook setup
app.use(json());
app.post('/api/bot', async (req, res) => {
  const update = req.body;
  try {
    await bot.handleUpdate(update);
    res.send('OK');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error processing update');
  }
});

// Set up webhook for Telegram
const setWebhook = () => {
  const webhookUrl = `https://${process.env.VERCEL_URL}/api/bot`; // Dynamically use Vercel URL for webhook
  bot.telegram.setWebhook(webhookUrl).then(() => {
    console.log('Webhook set successfully');
  }).catch((error) => {
    console.error('Error setting webhook:', error);
  });
};

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const name = `${ctx.from.first_name} ${ctx.from.last_name || ""}`.trim();
  const query = `
    query($telegramId: String!) {
      donors(where: { telegramId: $telegramId }) {
        id
        name
      }
    }
  `;
  const vars = { telegramId: String(userId) };
  const donorResponse = await requestHygraph(query, vars);

  if (donorResponse.data.donors.length > 0) {
    ctx.reply(`Welcome back, ${name}! You are already a registered donor.`);
  } else {
    ctx.reply(`Welcome ${name}!\n\nCommands:\n- /beadonor: Register as a donor\n- /requestblood: Request blood`);
  }
});

bot.command("beadonor", async (ctx) => {
  const userId = ctx.from.id;
  const name = `${ctx.from.first_name} ${ctx.from.last_name || ""}`.trim();

  ctx.reply(
    // biome-ignore lint/style/useTemplate: <explanation>
    `Hello ${name}! To become a donor, please provide the following details:\n\n` +
    // biome-ignore lint/style/noUnusedTemplateLiteral: <explanation>
    `1. Your Phone Number\n2. Blood Group (e.g., A+, B-, O+)\n3. Last Donation Date (yyyy-mm-dd)\n4. Location: Locality, Panchayat, District`
  );

  const donorInfo = {
    telegramId: userId,
    name: name,
    phoneNumber: null,
    bloodGroup: null,
    lastDonationDate: null,
    location: null
  };
  const userState = {};

  userState[userId] = donorInfo;

  bot.on('text', async (msgCtx) => {
    const responseText = msgCtx.message.text;
    const userId = msgCtx.from.id;

    const donor = userState[userId];

    if (!donor) return;

    if (!donor.phoneNumber) {
      donor.phoneNumber = responseText;
      await msgCtx.reply("Please provide your blood group (e.g., A+, B-, O+).");
    } else if (!donor.bloodGroup) {
      donor.bloodGroup = responseText;
      await msgCtx.reply("Please provide your last donation date (yyyy-mm-dd).");
    } else if (!donor.lastDonationDate) {
      donor.lastDonationDate = responseText;
      await msgCtx.reply("Please provide your location (Locality, Panchayat, District).");
    } else if (!donor.location) {
      donor.location = responseText;

      const mutation = `
        mutation($data: DonorCreateInput!) {
          createDonor(data: $data) {
            id
            name
          }
        }
      `;

      const variables = {
        data: {
          telegramId: String(donor.telegramId),
          name: donor.name,
          phoneNumber: donor.phoneNumber,
          bloodGroup: donor.bloodGroup,
          lastDonationDate: donor.lastDonationDate,
          location: {
            create: {
              locality: donor.location.split(",")[0],
              panchayat: donor.location.split(",")[1],
              district: donor.location.split(",")[2]
            }
          }
        }
      };

      await requestHygraph(mutation, variables);
      await msgCtx.reply("You have successfully registered as a blood donor! Thank you for your willingness to donate.");
      
      delete userState[userId];
    }
  });
});

bot.command("requestblood", async (ctx) => {
  const userId = ctx.from.id;

  ctx.reply("What is your blood group? (e.g., A+, B-, O+)");

  bot.on("text", async (msgCtx) => {
    const bloodGroup = msgCtx.message.text;
    ctx.reply("How many units of blood do you need?");

    bot.on("text", async (unitCtx) => {
      const unitsNeeded = Number.parseInt(unitCtx.message.text, 10);
      ctx.reply("Enter your location (Locality, Panchayat, District):");

      bot.on("text", async (locCtx) => {
        const location = locCtx.message.text;
        const requestData = { bloodGroup, unitsNeeded, location };

        // Eligible donors query
        const query = `
          query($bloodGroup: String!, $location: String!) {
            donors(where: { bloodGroup: $bloodGroup, location_contains: $location }) {
              name
              phoneNumber
              location {
                locality
                panchayat
                district
              }
            }
          }
        `;

        const variables = { bloodGroup, location };
        const donorsResponse = await requestHygraph(query, variables);

        if (donorsResponse.data.donors.length > 0) {
          const donorsList = donorsResponse.data.donors.map(donor => `
            Name: ${donor.name}
            Contact: ${donor.phoneNumber}
            Location: ${donor.location.locality}, ${donor.location.panchayat}, ${donor.location.district}
          `).join("\n\n");

          ctx.reply(`We found eligible donors for your request:\n\n${donorsList}`);
        } else {
          ctx.reply("Sorry, no donors are available at the moment.");
        }
      });
    });
  });
});

app.listen(3000, () => {
  console.log('Bot server is running on port 3000');
  setWebhook();
});
