const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static('public'));

// Game state management
const rooms = new Map();

class Card {
    constructor(suit, value) {
        this.suit = suit;
        this.value = value;
    }

    getNumericValue() {
        // Face cards: J=11, Q=12, K=13, A=1 (but special rules apply)
        if (this.value === 'J') return 11;
        if (this.value === 'Q') return 12;
        if (this.value === 'K') return 13;
        if (this.value === 'A') return 1;
        return parseInt(this.value);
    }

    compareWith(otherCard) {
        const thisVal = this.getNumericValue();
        const otherVal = otherCard.getNumericValue();

        // Ace is higher than face cards but lower than number cards
        if (thisVal === 1 && otherVal >= 11) return 1; // Ace beats face cards
        if (otherVal === 1 && thisVal >= 11) return -1; // Face cards lose to Ace
        
        // Face cards beat number cards (except Ace)
        if (thisVal >= 11 && otherVal >= 2 && otherVal <= 10) return 1;
        if (otherVal >= 11 && thisVal >= 2 && thisVal <= 10) return -1;
        
        // Normal comparison for same category
        if (thisVal > otherVal) return 1;
        if (thisVal < otherVal) return -1;
        return 0; // Equal
    }
}

class GameRoom {
    constructor(roomId) {
        this.id = roomId;
        this.players = new Map();
        this.gameState = 'waiting'; // waiting, playing, finished
        this.deck = [];
        this.currentCollector = null;
        this.currentChallenger = null;
        this.playedCards = new Map(); // playerId -> card
        this.potPile = [];
        this.discardPile = [];
        this.playerOrder = [];
        this.roundPhase = 'placement'; // placement, challenge, collection
        this.challengeCards = { collector: null, challenger: null };
        this.collectorPrediction = null; // 'higher' or 'lower'
    }

    addPlayer(playerId, playerName) {
        if (this.players.size >= 8) return false;
        
        this.players.set(playerId, {
            id: playerId,
            name: playerName,
            hand: [],
            collection: [],
            currentCard: null,
            ready: false
        });
        
        return true;
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
        if (this.players.size === 0) {
            return true; // Room should be deleted
        }
        return false;
    }

    createDeck() {
        const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
        const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
        
        this.deck = [];
        for (let suit of suits) {
            for (let value of values) {
                this.deck.push(new Card(suit, value));
            }
        }
        
        // Shuffle deck
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    dealCards() {
        const playerCount = this.players.size;
        const cardsPerPlayer = Math.floor(52 / playerCount);
        
        this.playerOrder = Array.from(this.players.keys());
        
        let cardIndex = 0;
        for (let playerId of this.playerOrder) {
            const player = this.players.get(playerId);
            player.hand = this.deck.slice(cardIndex, cardIndex + cardsPerPlayer);
            cardIndex += cardsPerPlayer;
        }
    }

    startGame() {
        if (this.players.size < 4) return false;
        
        this.createDeck();
        this.dealCards();
        this.currentCollector = this.playerOrder[0];
        this.gameState = 'playing';
        this.roundPhase = 'placement';
        
        return true;
    }

    placeCard(playerId, cardIndex) {
        const player = this.players.get(playerId);
        if (!player || cardIndex >= player.hand.length) return false;
        
        const card = player.hand.splice(cardIndex, 1)[0];
        this.playedCards.set(playerId, card);
        
        return true;
    }

    makeChallenge(prediction) {
        if (this.roundPhase !== 'challenge') return false;
        
        this.collectorPrediction = prediction;
        const collectorCard = this.playedCards.get(this.currentCollector);
        const challengerCard = this.playedCards.get(this.currentChallenger);
        
        const comparison = collectorCard.compareWith(challengerCard);
        let collectorWins = false;
        
        if (prediction === 'higher') {
            collectorWins = comparison > 0;
        } else {
            collectorWins = comparison < 0;
        }
        
        if (comparison === 0) {
            // Equal cards - both go to discard pile
            this.discardPile.push(collectorCard, challengerCard);
            this.playedCards.delete(this.currentCollector);
            this.playedCards.delete(this.currentChallenger);
            return { result: 'tie', needNewCards: true };
        }
        
        if (collectorWins) {
            // Collector wins - can continue or collect
            return { result: 'collector_wins', canContinue: true };
        } else {
            // Challenger wins - becomes new collector
            const oldCollector = this.currentCollector;
            this.currentCollector = this.currentChallenger;
            
            // Move uncollected cards to new collector's pot
            for (let [pid, card] of this.playedCards) {
                if (pid !== this.currentCollector) {
                    this.potPile.push(card);
                }
            }
            
            this.playedCards.clear();
            return { result: 'challenger_wins', newCollector: this.currentCollector };
        }
    }

    collectCards() {
        const collector = this.players.get(this.currentCollector);
        
        // Add pot pile to collector's collection
        collector.collection.push(...this.potPile);
        this.potPile = [];
        
        // Clear played cards
        this.playedCards.clear();
        
        // Next player becomes collector
        const currentIndex = this.playerOrder.indexOf(this.currentCollector);
        const nextIndex = (currentIndex + 1) % this.playerOrder.length;
        this.currentCollector = this.playerOrder[nextIndex];
        
        this.roundPhase = 'placement';
    }

    getGameState() {
        const players = Array.from(this.players.entries()).map(([id, player]) => ({
            id,
            name: player.name,
            handCount: player.hand.length,
            collectionCount: player.collection.length,
            hasPlayedCard: this.playedCards.has(id)
        }));

        return {
            roomId: this.id,
            gameState: this.gameState,
            roundPhase: this.roundPhase,
            players,
            currentCollector: this.currentCollector,
            currentChallenger: this.currentChallenger,
            potPileCount: this.potPile.length,
            discardPileCount: this.discardPile.length,
            collectorPrediction: this.collectorPrediction
        };
    }
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('join_room', (data) => {
        const { roomId, playerName } = data;
        
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new GameRoom(roomId));
        }
        
        const room = rooms.get(roomId);
        const success = room.addPlayer(socket.id, playerName);
        
        if (success) {
            socket.join(roomId);
            socket.emit('joined_room', { success: true, playerId: socket.id });
            io.to(roomId).emit('game_state', room.getGameState());
        } else {
            socket.emit('joined_room', { success: false, reason: 'Room full' });
        }
    });

    socket.on('start_game', () => {
        const roomId = Array.from(socket.rooms)[1]; // First room is socket.id
        if (!roomId) return;
        
        const room = rooms.get(roomId);
        if (room && room.startGame()) {
            io.to(roomId).emit('game_started');
            io.to(roomId).emit('game_state', room.getGameState());
            
            // Send private hand data to each player
            for (let [playerId, player] of room.players) {
                io.to(playerId).emit('hand_update', { 
                    hand: player.hand.map(card => ({ suit: card.suit, value: card.value }))
                });
            }
        }
    });

    socket.on('place_card', (data) => {
        const roomId = Array.from(socket.rooms)[1];
        if (!roomId) return;
        
        const room = rooms.get(roomId);
        if (room && room.roundPhase === 'placement') {
            const success = room.placeCard(socket.id, data.cardIndex);
            if (success) {
                io.to(roomId).emit('game_state', room.getGameState());
                
                // Check if all players have placed cards
                if (room.playedCards.size === room.players.size) {
                    room.roundPhase = 'challenge';
                    room.currentChallenger = room.playerOrder[
                        (room.playerOrder.indexOf(room.currentCollector) + 1) % room.playerOrder.length
                    ];
                    io.to(roomId).emit('challenge_phase', {
                        collector: room.currentCollector,
                        challenger: room.currentChallenger
                    });
                }
            }
        }
    });

    socket.on('make_challenge', (data) => {
        const roomId = Array.from(socket.rooms)[1];
        if (!roomId) return;
        
        const room = rooms.get(roomId);
        if (room && socket.id === room.currentCollector && room.roundPhase === 'challenge') {
            const result = room.makeChallenge(data.prediction);
            io.to(roomId).emit('challenge_result', result);
            io.to(roomId).emit('game_state', room.getGameState());
        }
    });

    socket.on('collect_cards', () => {
        const roomId = Array.from(socket.rooms)[1];
        if (!roomId) return;
        
        const room = rooms.get(roomId);
        if (room && socket.id === room.currentCollector) {
            room.collectCards();
            io.to(roomId).emit('cards_collected');
            io.to(roomId).emit('game_state', room.getGameState());
        }
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        for (let [roomId, room] of rooms) {
            if (room.players.has(socket.id)) {
                const shouldDelete = room.removePlayer(socket.id);
                
                if (shouldDelete) {
                    rooms.delete(roomId);
                } else {
                    io.to(roomId).emit('game_state', room.getGameState());
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});