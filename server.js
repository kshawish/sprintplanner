// server.js
const express = require('express');
const fs = require('fs').promises;
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());

// Add CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Load configuration
let config;
try {
  config = require('./config.json');
} catch (error) {
  console.warn('Config file not found, using environment variables');
  config = {
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || 'your-deepseek-api-key',
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com'
    },
    server: {
      port: process.env.PORT || 3000,
      dataFile: './data/team-data.json'
    },
    ai: {
      temperature: 0.3,
      maxTokens: 2000
    }
  };
}

// Data loading function
async function loadTeamData() {
  try {
    const data = await fs.readFile(config.server.dataFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`Failed to load team data: ${error.message}`);
  }
}

// DeepSeek API integration
async function callDeepSeekForSprintPlanning(teamData) {
  const prompt = `
You are a sprint planning assistant. Based on the following team data, create an optimal sprint plan.

Team Velocity: ${teamData.teamVelocity} story points per sprint
Sprint Length: ${teamData.sprintLength} weeks
Sprint Start Date: ${teamData.sprintStartDate}
Epics: ${JSON.stringify(teamData.epics, null, 2)}
Team Members: ${JSON.stringify(teamData.teamMembers, null, 2)}
Stories: ${JSON.stringify(teamData.stories, null, 2)}

IMPORTANT RULES:
1. Prioritize HIGH priority epics first - complete them before medium/low priority epics
2. Respect story dependencies - dependent stories must be in later sprints
3. Calculate sprint dates based on sprint length and start date
4. Group stories by epic and track epic completion

Please return a JSON response with the following structure:
{
  "sprints": [
    {
      "sprintNumber": 1,
      "startDate": "2025-08-12",
      "endDate": "2025-08-23",
      "totalPoints": 15,
      "stories": [
        {
          "storyId": "STORY-001",
          "epicId": "EPIC-001", 
          "assignee": "John Doe",
          "reason": "Best match for backend specialization"
        }
      ]
    }
  ],
  "epicSummary": [
    {
      "epicId": "EPIC-001",
      "title": "User Management System",
      "priority": "high",
      "totalPoints": 11,
      "completedInSprint": 2,
      "completionDate": "2025-08-23",
      "status": "completed"
    }
  ],
  "summary": {
    "totalSprints": 3,
    "totalStoryPoints": 45,
    "utilizationRate": "95%",
    "projectEndDate": "2025-09-15"
  }
}

Consider:
- Epic priority order (high → medium → low)
- Team member specializations and story requirements
- Story dependencies
- Sprint capacity based on team velocity
- Sprint calendar with actual dates
- Epic completion tracking
`;

  try {
    const response = await axios.post(
      `${config.deepseek.baseURL}/v1/chat/completions`,
      {
        model: config.deepseek.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert Agile sprint planning assistant. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: config.ai.temperature,
        max_tokens: config.ai.maxTokens
      },
      {
        headers: {
          'Authorization': `Bearer ${config.deepseek.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    let content = response.data.choices[0].message.content.trim();
    
    // Remove markdown code blocks
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    
    // Find JSON object boundaries
    const startIdx = content.indexOf('{');
    const endIdx = content.lastIndexOf('}');
    
    if (startIdx !== -1 && endIdx !== -1) {
      content = content.substring(startIdx, endIdx + 1);
    }
    
    return JSON.parse(content);
  } catch (error) {
    console.error('DeepSeek API Error Details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    
    if (error.response?.status === 402) {
      throw new Error(`DeepSeek API error: Insufficient credits or payment required. Please check your account balance at platform.deepseek.com`);
    }
    if (error.response?.status === 401) {
      throw new Error(`DeepSeek API error: Invalid API key. Please check your DEEPSEEK_API_KEY in .env file`);
    }
    throw new Error(`DeepSeek API error: ${error.message}`);
  }
}

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/team-data', async (req, res) => {
  try {
    const data = await loadTeamData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-sprint-plan', async (req, res) => {
  try {
    const teamData = await loadTeamData();
    
    // Try DeepSeek API first
    try {
      const sprintPlan = await callDeepSeekForSprintPlanning(teamData);
      res.json({
        success: true,
        data: sprintPlan,
        generatedAt: new Date().toISOString(),
        source: 'deepseek'
      });
    } catch (apiError) {
      // Fallback mock response if API fails
      const startDate = new Date(teamData.sprintStartDate);
      const mockSprintPlan = {
        sprints: [
          {
            sprintNumber: 1,
            startDate: teamData.sprintStartDate,
            endDate: new Date(startDate.getTime() + (teamData.sprintLength * 7 * 24 * 60 * 60 * 1000)).toISOString().split('T')[0],
            totalPoints: Math.min(teamData.teamVelocity, 
              teamData.stories.reduce((sum, story) => sum + story.estimationPoints, 0)),
            stories: teamData.stories.slice(0, 2).map(story => ({
              storyId: story.storyId,
              epicId: story.epicId,
              assignee: teamData.teamMembers[0]?.name || "Unassigned",
              reason: "Mock assignment - API unavailable"
            }))
          }
        ],
        epicSummary: teamData.epics.map(epic => ({
          epicId: epic.epicId,
          title: epic.title,
          priority: epic.priority,
          totalPoints: teamData.stories
            .filter(s => s.epicId === epic.epicId)
            .reduce((sum, s) => sum + s.estimationPoints, 0),
          completedInSprint: 1,
          completionDate: new Date(startDate.getTime() + (teamData.sprintLength * 7 * 24 * 60 * 60 * 1000)).toISOString().split('T')[0],
          status: "planned"
        })),
        summary: {
          totalSprints: Math.ceil(
            teamData.stories.reduce((sum, story) => sum + story.estimationPoints, 0) / teamData.teamVelocity
          ),
          totalStoryPoints: teamData.stories.reduce((sum, story) => sum + story.estimationPoints, 0),
          utilizationRate: "Mock data",
          projectEndDate: new Date(startDate.getTime() + (3 * teamData.sprintLength * 7 * 24 * 60 * 60 * 1000)).toISOString().split('T')[0]
        }
      };
      
      res.json({
        success: true,
        data: mockSprintPlan,
        generatedAt: new Date().toISOString(),
        source: 'mock',
        note: 'API unavailable - using mock data. Error: ' + apiError.message
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/update-team-data', async (req, res) => {
  try {
    const newData = req.body;
    await fs.writeFile(config.server.dataFile, JSON.stringify(newData, null, 2));
    res.json({ success: true, message: 'Team data updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(config.server.port, () => {
  console.log(`Sprint Planning Server running on port ${config.server.port}`);
  console.log(`Data file: ${config.server.dataFile}`);
});

module.exports = app;