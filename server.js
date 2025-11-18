const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nye-voting';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nye2025';

app.use(cors());
app.use(express.json());

// MongoDB Schema Definitions
const companySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const artistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  imageUrl: { type: String, required: true }
}, { _id: false });

const votingSessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  companyId: { type: String, required: true, index: true },
  title: { type: String, required: true },
  date: { type: String, required: true },
  artists: {
    hosts: [artistSchema],
    singers: [artistSchema],
    santas: [artistSchema],
    shows: [artistSchema]
  },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const voteSchema = new mongoose.Schema({
  votingSessionId: { type: String, required: true, index: true },
  companyId: { type: String, required: true, index: true },
  votes: {
    host: { type: String, required: true },
    singers: [{ type: String, required: true }],
    santa: { type: String, required: true },
    show: { type: String, required: true },
    additionalRequest: { type: String, default: '' }
  },
  timestamp: { type: Date, default: Date.now },
  ipAddress: { type: String }
});

const Company = mongoose.model('Company', companySchema);
const VotingSession = mongoose.model('VotingSession', votingSessionSchema);
const Vote = mongoose.model('Vote', voteSchema);

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

async function getCurrentVotingForCompany(companyId) {
  return await VotingSession.findOne({ 
    companyId, 
    isActive: true 
  }).sort({ createdAt: -1 });
}

async function getVoteCount(votingSessionId) {
  return await Vote.countDocuments({ votingSessionId });
}

const adminTokens = new Set();

function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
}

// Public API endpoints

app.get('/api/company/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const company = await Company.findOne({ id: companyId });

    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    res.json({
      id: company.id,
      name: company.name
    });
  } catch (error) {
    console.error('Error getting company:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/voting/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const company = await Company.findOne({ id: companyId });

    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const currentVoting = await getCurrentVotingForCompany(companyId);

    if (!currentVoting) {
      return res.json({ active: false });
    }

    const totalVotes = await getVoteCount(currentVoting.id);

    res.json({
      active: true,
      id: currentVoting.id,
      title: currentVoting.title,
      date: currentVoting.date,
      artists: currentVoting.artists,
      totalVotes,
      companyName: company.name
    });
  } catch (error) {
    console.error('Error getting voting session:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/vote', async (req, res) => {
  try {
    const { companyId, votingSessionId, votes } = req.body;

    const company = await Company.findOne({ id: companyId });
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const votingSession = await VotingSession.findOne({ 
      id: votingSessionId, 
      companyId: companyId,
      isActive: true 
    });

    if (!votingSession) {
      return res.status(400).json({ message: 'Invalid or expired voting session' });
    }

    if (!votes || typeof votes !== 'object') {
      return res.status(400).json({ message: 'Invalid votes data' });
    }

    const validHosts = votingSession.artists.hosts.map(h => h.name);
    if (!votes.host || !validHosts.includes(votes.host)) {
      return res.status(400).json({ message: 'Please select a valid host' });
    }

    if (!votes.singers || !Array.isArray(votes.singers) || 
        votes.singers.length === 0 || votes.singers.length > 2) {
      return res.status(400).json({ message: 'Please select 1-2 singers or bands' });
    }
    const validSingers = votingSession.artists.singers.map(s => s.name);
    for (const singer of votes.singers) {
      if (!validSingers.includes(singer)) {
        return res.status(400).json({ message: 'Invalid singer selected' });
      }
    }

    const validSantas = votingSession.artists.santas.map(s => s.name);
    if (!votes.santa || !validSantas.includes(votes.santa)) {
      return res.status(400).json({ message: 'Please select a valid Santa' });
    }

    const validShows = votingSession.artists.shows.map(s => s.name);
    if (!votes.show || !validShows.includes(votes.show)) {
      return res.status(400).json({ message: 'Please select a valid entertainment show' });
    }

    const additionalRequest = votes.additionalRequest || '';

    const newVote = new Vote({
      votingSessionId,
      companyId: companyId,
      votes: {
        host: votes.host,
        singers: votes.singers,
        santa: votes.santa,
        show: votes.show,
        additionalRequest
      },
      ipAddress: req.ip || req.connection.remoteAddress
    });

    await newVote.save();

    res.json({ success: true, message: 'Vote submitted successfully' });
  } catch (error) {
    console.error('Error submitting vote:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/results/:votingSessionId', async (req, res) => {
  try {
    const { votingSessionId } = req.params;
    const votingSession = await VotingSession.findOne({ id: votingSessionId });

    if (!votingSession) {
      return res.status(404).json({ message: 'Voting session not found' });
    }

    const allVotes = await Vote.find({ votingSessionId });

    const results = {
      hosts: {},
      singers: {},
      santas: {},
      shows: {},
      additionalRequests: []
    };

    votingSession.artists.hosts.forEach(host => {
      results.hosts[host.name] = { votes: 0, imageUrl: host.imageUrl };
    });
    votingSession.artists.singers.forEach(singer => {
      results.singers[singer.name] = { votes: 0, imageUrl: singer.imageUrl };
    });
    votingSession.artists.santas.forEach(santa => {
      results.santas[santa.name] = { votes: 0, imageUrl: santa.imageUrl };
    });
    votingSession.artists.shows.forEach(show => {
      results.shows[show.name] = { votes: 0, imageUrl: show.imageUrl };
    });

    allVotes.forEach(voteDoc => {
      if (results.hosts[voteDoc.votes.host]) {
        results.hosts[voteDoc.votes.host].votes++;
      }
      
      voteDoc.votes.singers.forEach(singer => {
        if (results.singers[singer]) {
          results.singers[singer].votes++;
        }
      });

      if (results.santas[voteDoc.votes.santa]) {
        results.santas[voteDoc.votes.santa].votes++;
      }

      if (results.shows[voteDoc.votes.show]) {
        results.shows[voteDoc.votes.show].votes++;
      }

      if (voteDoc.votes.additionalRequest) {
        results.additionalRequests.push({
          request: voteDoc.votes.additionalRequest,
          timestamp: voteDoc.timestamp
        });
      }
    });

    const formattedResults = {
      hosts: Object.entries(results.hosts)
        .map(([name, data]) => ({ name, votes: data.votes, imageUrl: data.imageUrl }))
        .sort((a, b) => b.votes - a.votes),
      singers: Object.entries(results.singers)
        .map(([name, data]) => ({ name, votes: data.votes, imageUrl: data.imageUrl }))
        .sort((a, b) => b.votes - a.votes),
      santas: Object.entries(results.santas)
        .map(([name, data]) => ({ name, votes: data.votes, imageUrl: data.imageUrl }))
        .sort((a, b) => b.votes - a.votes),
      shows: Object.entries(results.shows)
        .map(([name, data]) => ({ name, votes: data.votes, imageUrl: data.imageUrl }))
        .sort((a, b) => b.votes - a.votes),
      additionalRequests: results.additionalRequests
    };

    const company = await Company.findOne({ id: votingSession.companyId });

    res.json({
      active: votingSession.isActive,
      title: votingSession.title,
      date: votingSession.date,
      company: company.name,
      results: formattedResults,
      totalVotes: allVotes.length
    });
  } catch (error) {
    console.error('Error getting results:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin API endpoints

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Invalid password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);

  res.json({ token });
});

app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
  res.json({ valid: true });
});

app.post('/api/admin/create-company', authenticateAdmin, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Company name is required' });
    }

    const newCompany = new Company({
      id: crypto.randomBytes(16).toString('hex'),
      name
    });

    await newCompany.save();

    res.json({
      success: true,
      message: 'Company created successfully',
      company: newCompany
    });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/admin/companies', authenticateAdmin, async (req, res) => {
  try {
    const companies = await Company.find().sort({ createdAt: -1 });
    res.json(companies);
  } catch (error) {
    console.error('Error getting companies:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/admin/companies/:companyId', authenticateAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findOne({ id: companyId });
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    await VotingSession.deleteMany({ companyId });
    await Vote.deleteMany({ companyId });
    await Company.deleteOne({ id: companyId });

    res.json({
      success: true,
      message: 'Company and all related data deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/admin/create-voting', authenticateAdmin, async (req, res) => {
  try {
    const { companyId, title, date, artists } = req.body;

    if (!companyId || !title || !date || !artists) {
      return res.status(400).json({ message: 'Invalid voting session data' });
    }

    if (!artists.hosts || !Array.isArray(artists.hosts) || artists.hosts.length === 0 ||
        !artists.singers || !Array.isArray(artists.singers) || artists.singers.length === 0 ||
        !artists.santas || !Array.isArray(artists.santas) || artists.santas.length === 0 ||
        !artists.shows || !Array.isArray(artists.shows) || artists.shows.length === 0) {
      return res.status(400).json({ message: 'All artist categories must have at least one option' });
    }

    for (const host of artists.hosts) {
      if (!host.name || !host.imageUrl) {
        return res.status(400).json({ message: 'Each host must have name and imageUrl' });
      }
    }
    for (const singer of artists.singers) {
      if (!singer.name || !singer.imageUrl) {
        return res.status(400).json({ message: 'Each singer must have name and imageUrl' });
      }
    }
    for (const santa of artists.santas) {
      if (!santa.name || !santa.imageUrl) {
        return res.status(400).json({ message: 'Each santa must have name and imageUrl' });
      }
    }
    for (const show of artists.shows) {
      if (!show.name || !show.imageUrl) {
        return res.status(400).json({ message: 'Each show must have name and imageUrl' });
      }
    }

    const company = await Company.findOne({ id: companyId });
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    await VotingSession.updateMany({ companyId }, { isActive: false });

    const newVoting = new VotingSession({
      id: crypto.randomBytes(16).toString('hex'),
      companyId,
      title,
      date,
      artists: {
        hosts: artists.hosts,
        singers: artists.singers,
        santas: artists.santas,
        shows: artists.shows
      },
      isActive: true
    });

    await newVoting.save();

    res.json({
      success: true,
      message: 'Voting session created successfully',
      voting: newVoting
    });
  } catch (error) {
    console.error('Error creating voting session:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/admin/voting-sessions/:companyId', authenticateAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;
    const sessions = await VotingSession.find({ companyId }).sort({ createdAt: -1 });
    res.json(sessions);
  } catch (error) {
    console.error('Error getting voting sessions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.patch('/api/admin/voting-sessions/:votingSessionId/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { votingSessionId } = req.params;

    const session = await VotingSession.findOne({ id: votingSessionId });
    if (!session) {
      return res.status(404).json({ message: 'Voting session not found' });
    }

    session.isActive = !session.isActive;
    await session.save();

    res.json({
      success: true,
      message: `Voting session ${session.isActive ? 'activated' : 'deactivated'}`,
      session
    });
  } catch (error) {
    console.error('Error toggling voting session:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/admin/reset-voting/:votingSessionId', authenticateAdmin, async (req, res) => {
  try {
    const { votingSessionId } = req.params;

    const session = await VotingSession.findOne({ id: votingSessionId });
    if (!session) {
      return res.status(404).json({ message: 'Voting session not found' });
    }

    const result = await Vote.deleteMany({ votingSessionId });

    res.json({
      success: true,
      message: 'Voting session reset successfully',
      deletedVotes: result.deletedCount
    });
  } catch (error) {
    console.error('Error resetting voting session:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/admin/stats/:companyId', authenticateAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findOne({ id: companyId });
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const currentVoting = await getCurrentVotingForCompany(companyId);

    if (!currentVoting) {
      return res.json({ 
        active: false,
        company: company.name
      });
    }

    const totalVotes = await getVoteCount(currentVoting.id);
    const recentVotes = await Vote.find({ votingSessionId: currentVoting.id })
      .sort({ timestamp: -1 })
      .limit(10);

    res.json({
      active: true,
      company: company.name,
      session: currentVoting,
      totalVotes,
      recentVotes
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const companies = await Company.find();
    const stats = [];

    for (const company of companies) {
      const activeSessions = await VotingSession.countDocuments({ 
        companyId: company.id, 
        isActive: true 
      });
      const totalSessions = await VotingSession.countDocuments({ 
        companyId: company.id 
      });
      const totalVotes = await Vote.countDocuments({ 
        companyId: company.id 
      });

      stats.push({
        company: {
          id: company.id,
          name: company.name,
          createdAt: company.createdAt
        },
        activeSessions,
        totalSessions,
        totalVotes
      });
    }

    res.json(stats);
  } catch (error) {
    console.error('Error getting all stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/health', async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];

    res.json({
      status: 'ok',
      database: states[dbState]
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

async function startServer() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
    console.log(`📊 MongoDB: ${MONGODB_URI}`);
  });
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

startServer();