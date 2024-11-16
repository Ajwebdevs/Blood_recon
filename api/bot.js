// api/bot.js

require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const { post } = require('axios');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

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

bot.command('beadonor', (ctx) => {
  ctx.session = { step: 'phoneNumber', data: {} };
  ctx.reply('Please provide your phone number.');
});

bot.command('requestblood', (ctx) => {
  ctx.session = { step: 'bloodGroup', data: {} };
  ctx.reply('What is your blood group? (e.g., A+, B-, O+)');
});

bot.on('text', async (ctx) => {
  if (!ctx.session || !ctx.session.step) return;

  const text = ctx.message.text;
  const { step, data } = ctx.session;

  switch (step) {
    case 'phoneNumber':
      data.phoneNumber = text;
      ctx.session.step = 'bloodGroup';
      ctx.reply('Please provide your blood group (e.g., A+, B-, O+).');
      break;

    case 'bloodGroup':
      data.bloodGroup = text;
      if ('phoneNumber' in data) {
        ctx.session.step = 'lastDonationDate';
        ctx.reply('Please provide your last donation date (yyyy-mm-dd).');
      } else {
        ctx.session.step = 'unitsNeeded';
        ctx.reply('How many units of blood do you need?');
      }
      break;

    case 'lastDonationDate':
      data.lastDonationDate = text;
      ctx.session.step = 'location';
      ctx.reply('Please provide your location (Locality, Panchayat, District).');
      break;

    case 'unitsNeeded':
      const unitsNeeded = parseInt(text, 10);
      if (isNaN(unitsNeeded)) {
        ctx.reply('Please enter a valid number for units needed.');
        return;
      }
      data.unitsNeeded = unitsNeeded;
      ctx.session.step = 'location';
      ctx.reply('Enter your location (Locality, Panchayat, District):');
      break;

    case 'location':
      data.location = text;
      if ('phoneNumber' in data) {
        // Register donor
        await registerDonor(ctx, data);
      } else {
        // Handle blood request
        await handleBloodRequest(ctx, data);
      }
      ctx.session = null; // Reset session
      break;

    default:
      ctx.reply('An error occurred. Please try again.');
      ctx.session = null;
      break;
  }
});

async function registerDonor(ctx, donorData) {
  const locationParts = donorData.location.split(',').map(part => part.trim());
  const variables = {
    data: {
      telegramId: String(ctx.from.id),
      name: `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim(),
      phoneNumber: donorData.phoneNumber,
      bloodGroup: donorData.bloodGroup,
      lastDonationDate: donorData.lastDonationDate,
      location: {
        create: {
          locality: locationParts[0] || '',
          panchayat: locationParts[1] || '',
          district: locationParts[2] || ''
        }
      }
    }
  };

  const mutation = `
    mutation($data: DonorCreateInput!) {
      createDonor(data: $data) {
        id
        name
      }
    }
  `;

  await requestHygraph(mutation, variables);
  await ctx.reply('You have successfully registered as a blood donor! Thank you for your willingness to donate.');
}

async function handleBloodRequest(ctx, requestData) {
  const { bloodGroup, unitsNeeded, location } = requestData;

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
    `).join('\n\n');

    await ctx.reply(`We found eligible donors for your request:\n\n${donorsList}`);
  } else {
    await ctx.reply('Sorry, no donors are available at the moment.');
  }
}

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } catch (err) {
      console.error('Error handling update:', err);
      res.status(500).send('Internal server error');
    }
  } else {
    res.status(200).send('This endpoint is for Telegram bot updates.');
  }
};
